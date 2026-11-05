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

  test("exchangeCode posts the PKCE code and returns both tokens", async () => {
    const { client, seen } = clientFor(() =>
      jsonReply(200, { access_token: "at-new", refresh_token: "rt-new", expires_in: 3600 })
    );
    const out = await client.exchangeCode({
      code: "auth-code-1",
      codeVerifier: "verifier-1",
      redirectUri: "https://app.example/api/calendar/callback",
    });
    expect(out).toEqual({ accessToken: "at-new", refreshToken: "rt-new" });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toContain("oauth2.googleapis.com/token");
    expect(seen[0].init?.method).toBe("POST");
    const body = String(seen[0].init?.body ?? "");
    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("code=auth-code-1");
    expect(body).toContain("code_verifier=verifier-1");
    expect(body).toContain("redirect_uri=");
    expect(body).toContain("client_id=cid");
  });

  test("exchangeCode returns a null refresh token when Google omits it", async () => {
    const { client } = clientFor(() => jsonReply(200, { access_token: "at-only" }));
    const out = await client.exchangeCode({
      code: "c",
      codeVerifier: "v",
      redirectUri: "https://app.example/api/calendar/callback",
    });
    expect(out).toEqual({ accessToken: "at-only", refreshToken: null });
  });

  test("exchangeCode maps failures without leaking the code or verifier", async () => {
    const code = "code-secret-value";
    const verifier = "verifier-secret-value";
    const { client } = clientFor(() => jsonReply(400, { error: "invalid_grant" }));
    const auth = await client
      .exchangeCode({ code, codeVerifier: verifier, redirectUri: "https://app.example/x" })
      .catch((e: unknown) => e);
    expect((auth as GoogleError).kind).toBe("auth");
    expect((auth as GoogleError).message).not.toContain(code);
    expect((auth as GoogleError).message).not.toContain(verifier);

    const down = clientFor(() => {
      throw new Error("down");
    });
    const server = await down.client
      .exchangeCode({ code, codeVerifier: verifier, redirectUri: "https://app.example/x" })
      .catch((e: unknown) => e);
    expect((server as GoogleError).kind).toBe("server");

    const missing = clientFor(() => jsonReply(200, { refresh_token: "rt" }));
    const other = await missing.client
      .exchangeCode({ code, codeVerifier: verifier, redirectUri: "https://app.example/x" })
      .catch((e: unknown) => e);
    expect((other as GoogleError).kind).toBe("other");
    expect((other as GoogleError).message).not.toContain(code);
  });

  test("revokeToken posts to the revoke endpoint and never throws", async () => {
    const { client, seen } = clientFor(() => jsonReply(200, {}));
    await client.revokeToken("rt-1");
    expect(seen[0].url).toContain("oauth2.googleapis.com/revoke");
    expect(seen[0].init?.method).toBe("POST");

    const failing = clientFor(() => jsonReply(400, { error: "invalid_token" }));
    await failing.client.revokeToken("rt-bad");

    const down = clientFor(() => {
      throw new Error("down");
    });
    await down.client.revokeToken("rt-down");
  });

  test("deleteCalendar hits the calendar path with DELETE", async () => {
    const { client, seen } = clientFor(() => jsonReply(204, {}));
    await client.deleteCalendar("at", "cal-9");
    expect(seen[0].url).toBe("https://www.googleapis.com/calendar/v3/calendars/cal-9");
    expect(seen[0].init?.method).toBe("DELETE");

    const gone = clientFor(() => jsonReply(404, { error: "not found" }));
    const err = await gone.client.deleteCalendar("at", "missing").catch((e: unknown) => e);
    expect((err as GoogleError).kind).toBe("gone");
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
