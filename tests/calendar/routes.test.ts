import { describe, expect, mock, test } from "bun:test";
import { randomBytes } from "node:crypto";

mock.module("server-only", () => ({}));

const {
  handleCalendarCallback,
  handleCalendarConnect,
  handleCalendarCron,
  handleCalendarDisconnect,
} = await import("../../lib/calendar/handlers");
import type { CalendarRouteDeps } from "../../lib/calendar/handlers";
import type { CalendarConnectionRow } from "../../lib/calendar/queries";
import { signOauthState, verifyOauthState } from "../../lib/calendar/oauth";
import { encryptToken } from "../../lib/calendar/crypto";

const NOW = new Date("2026-11-05T00:00:00.000Z");

const CONFIG = {
  clientId: "cid",
  clientSecret: "csecret",
  tokenKey: randomBytes(32).toString("base64"),
  cronSecret: "cron-secret-value",
  appBaseUrl: "https://app.example",
  sessionSecret: "test-session-secret-0123456789abcdef",
};

function connectionRow(overrides: Partial<CalendarConnectionRow> = {}): CalendarConnectionRow {
  return {
    user_id: "user-1",
    google_calendar_id: "cal-1",
    refresh_token_enc: encryptToken("rt-plain", CONFIG.tokenKey),
    status: "active",
    sync_lock_until: null,
    created_at: "",
    updated_at: "",
    ...overrides,
  };
}

function fakeFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => handler(String(input), init)) as unknown as typeof fetch;
}

function googleFetch(tokens: Record<string, unknown>, status = 200): typeof fetch {
  const seen: string[] = [];
  return fakeFetch((url) => {
    seen.push(url);
    if (url.includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify(tokens), { status });
    }
    return new Response("{}", { status: 200 });
  });
}

function makeDeps(overrides: Partial<CalendarRouteDeps> = {}) {
  const calls: {
    upserted: unknown[];
    deletedLinks: string[];
    deletedConnections: string[];
    synced: string[];
  } = { upserted: [], deletedLinks: [], deletedConnections: [], synced: [] };
  const logs: string[] = [];
  const box: { current: CalendarConnectionRow | null } = { current: null };
  const rows: { list: CalendarConnectionRow[] } = { list: [] };
  const deps: CalendarRouteDeps = {
    enabled: () => true,
    sessionUserId: async () => "user-1",
    planForUser: async () => "pro",
    config: () => CONFIG,
    fetchFn: googleFetch({ access_token: "at-1", refresh_token: "rt-1" }),
    queries: {
      getConnection: async () => box.current,
      upsertConnection: async (i) => {
        calls.upserted.push(i);
        const row = connectionRow({
          user_id: i.userId,
          google_calendar_id: i.googleCalendarId,
          refresh_token_enc: i.refreshTokenEnc,
          status: i.status,
        });
        box.current = row;
        return row;
      },
      deleteConnection: async (userId) => {
        calls.deletedConnections.push(userId);
        box.current = null;
      },
      listActiveConnections: async () => rows.list,
      deleteLinksForUser: async (userId) => {
        calls.deletedLinks.push(userId);
      },
    },
    listOpenTasks: async () => [],
    runSync: async (userId) => {
      calls.synced.push(userId);
      return { created: 0, patched: 0, removed: 0, failed: 0 };
    },
    now: () => NOW,
    log: (message) => {
      logs.push(message);
    },
    ...overrides,
  };
  return { deps, calls, logs, box, rows };
}

function locationOf(res: Response): string | null {
  return res.headers.get("Location");
}

function setCookieOf(res: Response): string | null {
  return res.headers.get("Set-Cookie");
}

describe("handleCalendarConnect", () => {
  test("answers 404 when the feature is off", async () => {
    const { deps } = makeDeps({ enabled: () => false });
    const res = await handleCalendarConnect(deps, "https://app.example/api/calendar/connect");
    expect(res.status).toBe(404);
  });

  test("without a session it redirects to /login", async () => {
    const { deps } = makeDeps({ sessionUserId: async () => null });
    const res = await handleCalendarConnect(deps, "https://app.example/api/calendar/connect");
    expect(res.status).toBe(303);
    expect(locationOf(res)).toBe("/login");
  });

  test("a non pro user goes back to the account page", async () => {
    const { deps } = makeDeps({ planForUser: async () => "free" });
    const res = await handleCalendarConnect(deps, "https://app.example/api/calendar/connect");
    expect(locationOf(res)).toBe("/account?calendar=pro");
  });

  test("happy path sets the state cookie and redirects to Google", async () => {
    const { deps } = makeDeps();
    const res = await handleCalendarConnect(deps, "https://app.example/api/calendar/connect");
    expect(res.status).toBe(303);
    const location = locationOf(res) ?? "";
    expect(location).toContain("https://accounts.google.com/o/oauth2/auth");
    const url = new URL(location);
    const state = url.searchParams.get("state") ?? "";
    expect(state.length).toBeGreaterThan(0);
    const cookie = setCookieOf(res) ?? "";
    expect(cookie).toContain("settle_cal_oauth=");
    expect(cookie).toContain("Path=/api/calendar");
    expect(cookie).toContain("HttpOnly");
    const token = cookie.split("settle_cal_oauth=")[1].split(";")[0];
    const verified = await verifyOauthState(token, CONFIG.sessionSecret, NOW, "user-1");
    expect(verified?.state).toBe(state);
    expect(verified?.verifier.length ?? 0).toBeGreaterThanOrEqual(43);
    expect(url.searchParams.get("code_challenge")?.length ?? 0).toBeGreaterThan(0);
  });
});

describe("handleCalendarCallback", () => {
  async function signedCookie(userId: string, state = "csrf-1", verifier = "verifier-1"): Promise<string> {
    const token = await signOauthState({ state, verifier, userId }, CONFIG.sessionSecret, NOW);
    return `settle_cal_oauth=${token}`;
  }

  function callbackUrl(params: string): string {
    return `https://app.example/api/calendar/callback${params}`;
  }

  test("answers 404 when the feature is off", async () => {
    const { deps } = makeDeps({ enabled: () => false });
    const res = await handleCalendarCallback(deps, callbackUrl("?code=c&state=s"), null);
    expect(res.status).toBe(404);
  });

  test("without a session it redirects to /login", async () => {
    const { deps } = makeDeps({ sessionUserId: async () => null });
    const res = await handleCalendarCallback(deps, callbackUrl("?code=c&state=s"), null);
    expect(locationOf(res)).toBe("/login");
  });

  test("Google access_denied lands on the denied banner", async () => {
    const { deps } = makeDeps();
    const res = await handleCalendarCallback(deps, callbackUrl("?error=access_denied"), null);
    expect(locationOf(res)).toBe("/account?calendar=denied");
    expect(setCookieOf(res) ?? "").toContain("Max-Age=0");
  });

  test("other Google errors land on the error banner", async () => {
    const { deps } = makeDeps();
    const res = await handleCalendarCallback(deps, callbackUrl("?error=server_error"), null);
    expect(locationOf(res)).toBe("/account?calendar=error");
  });

  test("a missing cookie lands on error", async () => {
    const { deps } = makeDeps();
    const res = await handleCalendarCallback(deps, callbackUrl("?code=c&state=csrf-1"), null);
    expect(locationOf(res)).toBe("/account?calendar=error");
  });

  test("a mismatched state lands on error and never stores a row", async () => {
    const { deps, calls } = makeDeps();
    const cookie = await signedCookie("user-1", "csrf-1");
    const res = await handleCalendarCallback(deps, callbackUrl("?code=c&state=csrf-other"), cookie);
    expect(locationOf(res)).toBe("/account?calendar=error");
    expect(calls.upserted).toEqual([]);
  });

  test("a state for another user lands on error", async () => {
    const { deps, calls } = makeDeps();
    const cookie = await signedCookie("user-2", "csrf-1");
    const res = await handleCalendarCallback(deps, callbackUrl("?code=c&state=csrf-1"), cookie);
    expect(locationOf(res)).toBe("/account?calendar=error");
    expect(calls.upserted).toEqual([]);
  });

  test("happy path stores the encrypted token, syncs once and connects", async () => {
    const { deps, calls } = makeDeps();
    const cookie = await signedCookie("user-1", "csrf-1");
    const res = await handleCalendarCallback(deps, callbackUrl("?code=c&state=csrf-1"), cookie);
    expect(locationOf(res)).toBe("/account?calendar=connected");
    expect(setCookieOf(res) ?? "").toContain("Max-Age=0");
    expect(calls.upserted).toHaveLength(1);
    const stored = calls.upserted[0] as { refreshTokenEnc: string; status: string; googleCalendarId: null };
    expect(stored.status).toBe("active");
    expect(stored.googleCalendarId).toBeNull();
    expect(stored.refreshTokenEnc).not.toContain("rt-1");
    expect(calls.synced).toEqual(["user-1"]);
  });

  test("connecting again keeps the existing Settle calendar", async () => {
    const { deps, calls, box } = makeDeps();
    box.current = connectionRow({ google_calendar_id: "cal-existing", status: "needs_reconnect" });
    const cookie = await signedCookie("user-1", "csrf-1");
    const res = await handleCalendarCallback(deps, callbackUrl("?code=c&state=csrf-1"), cookie);
    expect(locationOf(res)).toBe("/account?calendar=connected");
    const stored = calls.upserted[0] as { googleCalendarId: string | null; status: string };
    expect(stored.googleCalendarId).toBe("cal-existing");
    expect(stored.status).toBe("active");
  });

  test("a missing refresh token lands on error without storing", async () => {
    const { deps, calls } = makeDeps({
      fetchFn: googleFetch({ access_token: "at-1" }),
    });
    const cookie = await signedCookie("user-1", "csrf-1");
    const res = await handleCalendarCallback(deps, callbackUrl("?code=c&state=csrf-1"), cookie);
    expect(locationOf(res)).toBe("/account?calendar=error");
    expect(calls.upserted).toEqual([]);
    expect(calls.synced).toEqual([]);
  });

  test("a throwing exchange logs one clean line and lands on error", async () => {
    const code = "code-secret-value";
    const { deps, logs } = makeDeps({
      fetchFn: fakeFetch(() => {
        throw new Error("down");
      }),
    });
    const cookie = await signedCookie("user-1", "csrf-1");
    const res = await handleCalendarCallback(deps, callbackUrl(`?code=${code}&state=csrf-1`), cookie);
    expect(locationOf(res)).toBe("/account?calendar=error");
    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toContain(code);
    expect(logs[0]).not.toContain("verifier-1");
    expect(logs[0]).not.toContain("user-1");
  });

  test("a failing first sync still connects", async () => {
    const { deps, calls } = makeDeps({
      runSync: async () => {
        throw new Error("sync down");
      },
    });
    const cookie = await signedCookie("user-1", "csrf-1");
    const res = await handleCalendarCallback(deps, callbackUrl("?code=c&state=csrf-1"), cookie);
    expect(locationOf(res)).toBe("/account?calendar=connected");
    expect(calls.upserted).toHaveLength(1);
  });
});

describe("handleCalendarDisconnect", () => {
  test("answers 404 when the feature is off", async () => {
    const { deps } = makeDeps({ enabled: () => false });
    expect((await handleCalendarDisconnect(deps)).status).toBe(404);
  });

  test("without a session it redirects to /login", async () => {
    const { deps } = makeDeps({ sessionUserId: async () => null });
    expect(locationOf(await handleCalendarDisconnect(deps))).toBe("/login");
  });

  test("happy path cleans Google and the rows, then disconnects", async () => {
    const googleCalls: string[] = [];
    const { deps, calls, box } = makeDeps({
      fetchFn: fakeFetch((url) => {
        googleCalls.push(url);
        if (url.includes("oauth2.googleapis.com/token")) {
          return new Response(JSON.stringify({ access_token: "at-9" }), { status: 200 });
        }
        return new Response("{}", { status: 200 });
      }),
    });
    box.current = connectionRow();
    const res = await handleCalendarDisconnect(deps);
    expect(locationOf(res)).toBe("/account?calendar=disconnected");
    expect(googleCalls.some((u) => u.includes("oauth2.googleapis.com/token"))).toBe(true);
    expect(googleCalls.some((u) => u.includes("/calendars/cal-1"))).toBe(true);
    expect(googleCalls.some((u) => u.includes("oauth2.googleapis.com/revoke"))).toBe(true);
    expect(calls.deletedLinks).toEqual(["user-1"]);
    expect(calls.deletedConnections).toEqual(["user-1"]);
  });

  test("a dead Google still deletes the rows and disconnects", async () => {
    const { deps, calls, box } = makeDeps({
      fetchFn: fakeFetch(() => {
        throw new Error("down");
      }),
    });
    box.current = connectionRow();
    const res = await handleCalendarDisconnect(deps);
    expect(locationOf(res)).toBe("/account?calendar=disconnected");
    expect(calls.deletedLinks).toEqual(["user-1"]);
    expect(calls.deletedConnections).toEqual(["user-1"]);
  });

  test("without a connection it still deletes the rows", async () => {
    const { deps, calls } = makeDeps();
    const res = await handleCalendarDisconnect(deps);
    expect(locationOf(res)).toBe("/account?calendar=disconnected");
    expect(calls.deletedLinks).toEqual(["user-1"]);
    expect(calls.deletedConnections).toEqual(["user-1"]);
  });

  test("a failing row delete lands on error", async () => {
    const { deps, logs } = makeDeps({
      queries: {
        getConnection: async () => null,
        upsertConnection: async (i) => connectionRow({ user_id: i.userId }),
        deleteConnection: async () => {},
        listActiveConnections: async () => [],
        deleteLinksForUser: async () => {
          throw new Error("db down");
        },
      },
    });
    const res = await handleCalendarDisconnect(deps);
    expect(locationOf(res)).toBe("/account?calendar=error");
    expect(logs).toHaveLength(1);
  });
});

describe("handleCalendarCron", () => {
  test("answers 404 when the feature is off", async () => {
    const { deps } = makeDeps({ enabled: () => false });
    const res = await handleCalendarCron(deps, `Bearer ${CONFIG.cronSecret}`);
    expect(res.status).toBe(404);
  });

  test("rejects a missing, bare or wrong secret with 401", async () => {
    const { deps } = makeDeps();
    for (const header of [null, undefined, "", "Bearer ", "Bearer wrong-secret-value!", "Token abc"]) {
      const res = await handleCalendarCron(deps, header);
      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain(CONFIG.cronSecret);
    }
  });

  test("a different length secret also answers 401", async () => {
    const { deps } = makeDeps();
    const res = await handleCalendarCron(deps, "Bearer short");
    expect(res.status).toBe(401);
  });

  test("happy path syncs every active connection and reports counts", async () => {
    const { deps, calls, rows } = makeDeps({
      runSync: async (userId) => {
        calls.synced.push(userId);
        return userId === "user-1"
          ? { created: 2, patched: 1, removed: 0, failed: 0 }
          : { created: 0, patched: 0, removed: 1, failed: 1 };
      },
    });
    rows.list = [connectionRow(), connectionRow({ user_id: "user-2" })];
    const res = await handleCalendarCron(deps, `Bearer ${CONFIG.cronSecret}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ users: 2, created: 2, patched: 1, removed: 1, failed: 1 });
    expect(calls.synced).toEqual(["user-1", "user-2"]);
  });

  test("a throwing sync counts as failed and never stops the rest", async () => {
    const { deps, rows } = makeDeps({
      runSync: async () => {
        throw new Error("sync down");
      },
    });
    rows.list = [connectionRow()];
    const res = await handleCalendarCron(deps, `Bearer ${CONFIG.cronSecret}`);
    expect(await res.json()).toEqual({ users: 1, created: 0, patched: 0, removed: 0, failed: 1 });
  });

  test("the run stops starting new syncs after the budget", async () => {
    let at = NOW.getTime();
    const { deps, calls, rows } = makeDeps({ now: () => new Date(at) });
    deps.runSync = async (userId) => {
      calls.synced.push(userId);
      at += 60 * 1000;
      return { created: 1, patched: 0, removed: 0, failed: 0 };
    };
    rows.list = [connectionRow(), connectionRow({ user_id: "user-2" })];
    const res = await handleCalendarCron(deps, `Bearer ${CONFIG.cronSecret}`);
    expect(await res.json()).toEqual({ users: 1, created: 1, patched: 0, removed: 0, failed: 0 });
    expect(calls.synced).toEqual(["user-1"]);
  });

  test("the real deps builder wires the session, the plan and storage", async () => {
    const { realCalendarRouteDeps } = await import("../../lib/calendar/runtime");
    const deps = realCalendarRouteDeps();
    expect(typeof deps.sessionUserId).toBe("function");
    expect(typeof deps.planForUser).toBe("function");
    expect(typeof deps.runSync).toBe("function");
    expect(typeof deps.config).toBe("function");
  });
});
