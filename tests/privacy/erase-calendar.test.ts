import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { makeFakeDb } from "./fake-supabase";
import { PAST, TASK_A1, USER_A, baseTables } from "./fixtures";
import { encryptToken } from "../../lib/calendar/crypto";
import { eraseUser, type EraseCalendarDeps } from "../../lib/privacy/erase";
import type { StorageApi } from "../../lib/privacy/storage";

const NOW = () => new Date("2026-10-31T00:00:00.000Z");
const REFRESH = "refresh-token-secret-1";
const CALENDAR_ID = "settle-calendar-1";

function storageOf(fakeDb: ReturnType<typeof makeFakeDb>): StorageApi {
  return (fakeDb.client as unknown as { storage: StorageApi }).storage;
}

type FetchCall = { method: string; url: string; body: string };

function makeGoogleFetch(calls: FetchCall[], mode: "ok" | "down" = "ok"): typeof fetch {
  return (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({ method: init?.method ?? "GET", url, body });
    if (mode === "down") throw new Error("google is down");
    if (url.includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "access-1", expires_in: 3600 }), {
        status: 200,
      });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
}

// An unblocked world with a connected calendar: the subscription is expired
// and user A holds a connection plus one event link.
function connectedTables(keyBase64: string) {
  const tables = baseTables();
  for (const row of tables.subscriptions ?? []) {
    if (row.user_id === USER_A) row.current_period_end = PAST;
  }
  tables.calendar_connections = [
    {
      user_id: USER_A,
      google_calendar_id: CALENDAR_ID,
      refresh_token_enc: encryptToken(REFRESH, keyBase64),
      status: "active",
      sync_lock_until: null,
      created_at: "2026-10-20T00:00:00.000Z",
      updated_at: "2026-10-20T00:00:00.000Z",
    },
  ];
  tables.calendar_event_links = [
    {
      task_id: TASK_A1,
      user_id: USER_A,
      google_event_id: "event-1",
      synced_hash: "hash-1",
      synced_at: "2026-10-20T00:00:00.000Z",
    },
  ];
  return tables;
}

function calendarDeps(calls: FetchCall[], overrides: Partial<EraseCalendarDeps> = {}): EraseCalendarDeps {
  return {
    enabled: () => true,
    tokenKey: overrides.tokenKey === undefined ? KEY : overrides.tokenKey,
    clientId: "client-id",
    clientSecret: "client-secret",
    fetchFn: makeGoogleFetch(calls),
    ...overrides,
  };
}

const KEY = randomBytes(32).toString("base64");

describe("eraseUser calendar cleanup", () => {
  test("a connected user: Google calendar deleted, token revoked, rows gone by cascade", async () => {
    const calls: FetchCall[] = [];
    const fake = makeFakeDb(connectedTables(KEY));
    const report = await eraseUser(
      {
        client: fake.client,
        storage: storageOf(fake),
        bucket: "uploads",
        now: NOW,
        calendar: calendarDeps(calls),
      },
      { userId: USER_A, dryRun: false },
    );
    expect(report.status).toBe("erased");
    expect(report.calendarCleanupAttempted).toBe(true);
    const urls = calls.map((call) => call.url);
    expect(urls.some((url) => url.includes("oauth2.googleapis.com/token"))).toBe(true);
    expect(
      urls.some((url) => url.includes(`calendars/${CALENDAR_ID}`) && url.includes("googleapis")),
    ).toBe(true);
    const revoke = calls.find((call) => call.url.includes("oauth2.googleapis.com/revoke"));
    expect(revoke).toBeDefined();
    expect(new URLSearchParams(revoke!.body).get("token")).toBe(REFRESH);
    // The cascade removed the rows with the users row.
    expect(fake.data.calendar_connections ?? []).toEqual([]);
    expect(fake.data.calendar_event_links ?? []).toEqual([]);
    // The report carries only the attempt flag, never ids or tokens.
    const printed = JSON.stringify(report);
    expect(printed).not.toContain(REFRESH);
    expect(printed).not.toContain(CALENDAR_ID);
  });

  test("no connection: no Google calls, deletion still succeeds", async () => {
    const calls: FetchCall[] = [];
    const tables = baseTables();
    tables.calendar_connections = [];
    tables.calendar_event_links = [];
    for (const row of tables.subscriptions ?? []) {
      if (row.user_id === USER_A) row.current_period_end = PAST;
    }
    const fake = makeFakeDb(tables);
    const report = await eraseUser(
      {
        client: fake.client,
        storage: storageOf(fake),
        bucket: "uploads",
        now: NOW,
        calendar: calendarDeps(calls),
      },
      { userId: USER_A, dryRun: false },
    );
    expect(report.status).toBe("erased");
    expect(report.calendarCleanupAttempted).toBe(false);
    expect(calls).toEqual([]);
  });

  test("Google down: the deletion still succeeds", async () => {
    const calls: FetchCall[] = [];
    const fake = makeFakeDb(connectedTables(KEY));
    const report = await eraseUser(
      {
        client: fake.client,
        storage: storageOf(fake),
        bucket: "uploads",
        now: NOW,
        calendar: {
          enabled: () => true,
          tokenKey: KEY,
          clientId: "client-id",
          clientSecret: "client-secret",
          fetchFn: makeGoogleFetch(calls, "down"),
        },
      },
      { userId: USER_A, dryRun: false },
    );
    expect(report.status).toBe("erased");
    expect(report.calendarCleanupAttempted).toBe(true);
  });

  test("a bad key: decrypt fails, the deletion still succeeds", async () => {
    const calls: FetchCall[] = [];
    const fake = makeFakeDb(connectedTables(KEY));
    const report = await eraseUser(
      {
        client: fake.client,
        storage: storageOf(fake),
        bucket: "uploads",
        now: NOW,
        calendar: calendarDeps(calls, { tokenKey: randomBytes(32).toString("base64") }),
      },
      { userId: USER_A, dryRun: false },
    );
    expect(report.status).toBe("erased");
    expect(report.calendarCleanupAttempted).toBe(true);
    // Decrypt failed before any network call.
    expect(calls).toEqual([]);
  });

  test("feature env missing: no Google calls, deletion succeeds", async () => {
    const calls: FetchCall[] = [];
    const fake = makeFakeDb(connectedTables(KEY));
    const report = await eraseUser(
      {
        client: fake.client,
        storage: storageOf(fake),
        bucket: "uploads",
        now: NOW,
        calendar: { ...calendarDeps(calls), enabled: () => false },
      },
      { userId: USER_A, dryRun: false },
    );
    expect(report.status).toBe("erased");
    expect(report.calendarCleanupAttempted).toBe(false);
    expect(calls).toEqual([]);
  });

  test("a connection without a token: no Google calls", async () => {
    const calls: FetchCall[] = [];
    const tables = connectedTables(KEY);
    tables.calendar_connections = [
      {
        user_id: USER_A,
        google_calendar_id: null,
        refresh_token_enc: null,
        status: "needs_reconnect",
        sync_lock_until: null,
        created_at: "2026-10-20T00:00:00.000Z",
        updated_at: "2026-10-20T00:00:00.000Z",
      },
    ];
    const fake = makeFakeDb(tables);
    const report = await eraseUser(
      {
        client: fake.client,
        storage: storageOf(fake),
        bucket: "uploads",
        now: NOW,
        calendar: calendarDeps(calls),
      },
      { userId: USER_A, dryRun: false },
    );
    expect(report.status).toBe("erased");
    expect(report.calendarCleanupAttempted).toBe(false);
    expect(calls).toEqual([]);
  });

  test("a token but no calendar id: revoke still runs, no calendar delete", async () => {
    const calls: FetchCall[] = [];
    const tables = connectedTables(KEY);
    tables.calendar_connections = [
      {
        user_id: USER_A,
        google_calendar_id: null,
        refresh_token_enc: encryptToken(REFRESH, KEY),
        status: "active",
        sync_lock_until: null,
        created_at: "2026-10-20T00:00:00.000Z",
        updated_at: "2026-10-20T00:00:00.000Z",
      },
    ];
    const fake = makeFakeDb(tables);
    const report = await eraseUser(
      {
        client: fake.client,
        storage: storageOf(fake),
        bucket: "uploads",
        now: NOW,
        calendar: calendarDeps(calls),
      },
      { userId: USER_A, dryRun: false },
    );
    expect(report.status).toBe("erased");
    expect(report.calendarCleanupAttempted).toBe(true);
    expect(calls.some((call) => call.url.includes("oauth2.googleapis.com/revoke"))).toBe(true);
    expect(calls.some((call) => call.url.includes("www.googleapis.com/calendar"))).toBe(false);
  });

  test("a dry run never touches Google", async () => {
    const calls: FetchCall[] = [];
    const fake = makeFakeDb(connectedTables(KEY));
    const report = await eraseUser(
      {
        client: fake.client,
        storage: storageOf(fake),
        bucket: "uploads",
        now: NOW,
        calendar: calendarDeps(calls),
      },
      { userId: USER_A, dryRun: true },
    );
    expect(report.status).toBe("dry_run");
    expect(report.calendarCleanupAttempted).toBe(false);
    expect(calls).toEqual([]);
  });
});
