import { describe, expect, test } from "bun:test";
import { createGoogleClient, GoogleError } from "../../lib/calendar/google";
import type { CalendarEventBody } from "../../lib/calendar/event";

const TOKEN = "tok-live-secret-value";
const EVENT: CalendarEventBody = {
  summary: "Math assignment",
  description: "Added by SettleNotes",
  start: { dateTime: "2026-11-01T00:00:00+08:00", timeZone: "Asia/Singapore" },
  end: { dateTime: "2026-11-01T00:15:00+08:00", timeZone: "Asia/Singapore" },
  reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 60 }] },
};

function jsonReply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function clientFor(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const seen: { url: string; init?: RequestInit }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  const client = createGoogleClient({ clientId: "cid", clientSecret: "csecret", fetch: fetchFn });
  return { client, seen };
}

describe("google client error mapping", () => {
  test("refresh returns the access token", async () => {
    const { client, seen } = clientFor(() => jsonReply(200, { access_token: "at-1", expires_in: 3600 }));
    const out = await client.refreshAccessToken("refresh-1");
    expect(out).toEqual({ accessToken: "at-1", expiresIn: 3600 });
    expect(seen[0].url).toContain("oauth2.googleapis.com");
  });

  test("401 maps to auth", async () => {
    const { client } = clientFor(() => jsonReply(401, { error: "unauthorized" }));
    const err = await client.refreshAccessToken("r").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleError);
    expect((err as GoogleError).kind).toBe("auth");
  });

  test("invalid_grant on a 400 maps to auth", async () => {
    const { client } = clientFor(() => jsonReply(400, { error: "invalid_grant" }));
    const err = await client.refreshAccessToken("r").catch((e: unknown) => e);
    expect((err as GoogleError).kind).toBe("auth");
  });

  test("404 and 410 map to gone, 429 to rate, 500 to server, other 400 to other", async () => {
    for (const [status, kind] of [
      [404, "gone"],
      [410, "gone"],
      [429, "rate"],
      [500, "server"],
      [503, "server"],
      [400, "other"],
    ] as const) {
      const { client } = clientFor(() => jsonReply(status, { error: "x" }));
      const err = await client.deleteEvent("at", "cal", "ev").catch((e: unknown) => e);
      expect((err as GoogleError).kind).toBe(kind);
    }
  });

  test("network failure maps to server", async () => {
    const { client } = clientFor(() => {
      throw new Error("down");
    });
    const err = await client.deleteEvent("at", "cal", "ev").catch((e: unknown) => e);
    expect((err as GoogleError).kind).toBe("server");
  });

  test("error messages never carry tokens or bodies", async () => {
    const { client } = clientFor(() => jsonReply(400, { error: `leak ${TOKEN} happened` }));
    const err = await client.refreshAccessToken(TOKEN).catch((e: unknown) => e);
    expect((err as GoogleError).message).not.toContain(TOKEN);
    expect((err as GoogleError).message).not.toContain("leak");
  });

  test("getCalendarExists returns false on gone instead of throwing", async () => {
    const { client } = clientFor(() => jsonReply(404, { error: "not found" }));
    expect(await client.getCalendarExists("at", "missing")).toBe(false);
  });

  test("403 quota reasons map to rate", async () => {
    for (const reason of [
      "rateLimitExceeded",
      "userRateLimitExceeded",
      "quotaExceeded",
      "dailyLimitExceeded",
    ]) {
      const { client } = clientFor(
        () => new Response(JSON.stringify({ error: { errors: [{ reason }] } }), { status: 403 })
      );
      const err = await client.deleteEvent("at", "cal", "ev").catch((e: unknown) => e);
      expect((err as GoogleError).kind).toBe("rate");
      expect((err as GoogleError).message).not.toContain(reason);
    }
  });

  test("403 permission reasons map to auth", async () => {
    for (const body of [
      JSON.stringify({ error: { errors: [{ reason: "insufficientPermissions" }] } }),
      "Request had insufficient authentication scopes.",
    ]) {
      const { client } = clientFor(() => new Response(body, { status: 403 }));
      const err = await client.deleteEvent("at", "cal", "ev").catch((e: unknown) => e);
      expect((err as GoogleError).kind).toBe("auth");
    }
  });

  test("403 with an unknown body maps to other without leaking the body", async () => {
    const { client } = clientFor(() => new Response("some-secret-body-text", { status: 403 }));
    const err = (await client.deleteEvent("at", "cal", "ev").catch((e: unknown) => e)) as GoogleError;
    expect(err.kind).toBe("other");
    expect(err.message).not.toContain("some-secret-body-text");
  });

  test("insertEvent sends exactly one Bearer token header", async () => {
    const { client, seen } = clientFor(() => jsonReply(200, { id: "ev-1" }));
    await client.insertEvent("tok_test", "cal-1", EVENT);
    const headers = seen[0].init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok_test");
  });

  test("calendar and event calls hit the expected paths", async () => {
    const { client, seen } = clientFor((url) => {
      if (url.endsWith("/calendars")) return jsonReply(200, { id: "cal-9" });
      if (url.endsWith("/events")) return jsonReply(200, { id: "ev-9" });
      return jsonReply(200, {});
    });
    expect(await client.createCalendar("at", "Settle")).toEqual({ id: "cal-9" });
    expect(await client.insertEvent("at", "cal-9", EVENT)).toEqual({ id: "ev-9" });
    await client.patchEvent("at", "cal-9", "ev-9", EVENT);
    await client.deleteEvent("at", "cal-9", "ev-9");
    expect(await client.getCalendarExists("at", "cal-9")).toBe(true);
    expect(seen.map((s) => s.url)).toEqual([
      "https://www.googleapis.com/calendar/v3/calendars",
      "https://www.googleapis.com/calendar/v3/calendars/cal-9/events",
      "https://www.googleapis.com/calendar/v3/calendars/cal-9/events/ev-9",
      "https://www.googleapis.com/calendar/v3/calendars/cal-9/events/ev-9",
      "https://www.googleapis.com/calendar/v3/calendars/cal-9",
    ]);
  });
});
