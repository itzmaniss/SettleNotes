import { describe, expect, test } from "bun:test";
import {
  buildDataCheckString,
  handleTelegramLogin,
  type TelegramLoginDeps,
} from "../../lib/auth/telegram-login";
import { createHash, createHmac } from "node:crypto";

const BOT_TOKEN = "123456:TestTokenForVectorDoNotUse";
const AUTH_DATE = 1760000000;
const NOW = new Date(AUTH_DATE * 1000);
const ORIGIN = "https://settle.example.com";
const LOCAL_ORIGIN = "http://localhost:3000";

function sign(fields: Record<string, string>): string {
  const secret = createHash("sha256").update(BOT_TOKEN, "utf8").digest();
  return createHmac("sha256", secret)
    .update(buildDataCheckString(fields), "utf8")
    .digest("hex");
}

type FakeDeps = {
  deps: TelegramLoginDeps;
  upsertCalls: unknown[];
  sessionCalls: string[];
};

function makeDeps(overrides: Partial<TelegramLoginDeps> = {}): FakeDeps {
  const upsertCalls: unknown[] = [];
  const sessionCalls: string[] = [];
  return {
    upsertCalls,
    sessionCalls,
    deps: {
      botToken: BOT_TOKEN,
      access: [900000001],
      getUserByTelegramId: async () => null,
      upsertUser: async (input) => {
        upsertCalls.push(input);
        return { id: "user-1" };
      },
      createSession: async (userId) => {
        sessionCalls.push(userId);
        return `jwt-for-${userId}`;
      },
      now: NOW,
      ...overrides,
    },
  };
}

function loginRequest(search: string, origin = ORIGIN): Request {
  return new Request(`${origin}/auth/telegram${search}`);
}

function signedSearch(extra: string[] = []): string {
  const fields = { id: "900000001", first_name: "Wei", auth_date: String(AUTH_DATE) };
  const parts = Object.entries(fields).map(([key, value]) => `${key}=${value}`);
  return `?${[...parts, `hash=${sign(fields)}`, ...extra].join("&")}`;
}

describe("handleTelegramLogin (app/auth/telegram GET logic)", () => {
  test("valid callback: 303 to the dashboard, session cookie with magic link flags", async () => {
    const ctx = makeDeps();

    const res = await handleTelegramLogin(loginRequest(signedSearch()), ctx.deps);

    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}/dashboard`);
    expect(ctx.sessionCalls).toEqual(["user-1"]);

    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("settle_session=jwt-for-user-1");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=604800");
    expect(cookie).toContain("Secure");

    // The signed query is a bearer payload: no caching, no referrer leak.
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  test("a localhost origin keeps the cookie non Secure", async () => {
    const ctx = makeDeps();
    const res = await handleTelegramLogin(loginRequest(signedSearch(), LOCAL_ORIGIN), ctx.deps);
    expect(res.headers.get("Location")).toBe(`${LOCAL_ORIGIN}/dashboard`);
    expect(res.headers.get("Set-Cookie") ?? "").not.toContain("Secure");
  });

  test("an allowed next path is honoured", async () => {
    const ctx = makeDeps();
    const res = await handleTelegramLogin(loginRequest(`${signedSearch()}&next=/tasks`), ctx.deps);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}/tasks`);
  });

  test("open redirect attempts all fall back to the dashboard", async () => {
    for (const next of [
      "//evil.com",
      "https://evil.com",
      "/\\evil",
      "/dashboard/../x",
      "/login",
      "tasks",
    ]) {
      const ctx = makeDeps();
      const res = await handleTelegramLogin(
        loginRequest(`${signedSearch()}&next=${encodeURIComponent(next)}`),
        ctx.deps,
      );
      expect(res.headers.get("Location"), `next ${next}`).toBe(`${ORIGIN}/dashboard`);
      expect(ctx.sessionCalls).toEqual(["user-1"]);
    }
  });

  test("a stranger is redirected to the not invited banner with no cookie", async () => {
    const ctx = makeDeps({ access: [111111111] });

    const res = await handleTelegramLogin(loginRequest(signedSearch()), ctx.deps);

    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}/login?error=not_invited`);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(ctx.upsertCalls).toEqual([]);
    expect(ctx.sessionCalls).toEqual([]);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  test("an invalid callback is redirected to the failed banner with no cookie", async () => {
    const ctx = makeDeps();
    const res = await handleTelegramLogin(loginRequest(signedSearch(["extra=1"])), ctx.deps);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}/login?error=failed`);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(ctx.upsertCalls).toEqual([]);
  });

  test("a repeated query param is rejected as invalid", async () => {
    const ctx = makeDeps();
    const res = await handleTelegramLogin(
      loginRequest(`${signedSearch()}&id=900000001`),
      ctx.deps,
    );
    expect(res.headers.get("Location")).toBe(`${ORIGIN}/login?error=failed`);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(ctx.upsertCalls).toEqual([]);
    expect(ctx.sessionCalls).toEqual([]);
  });

  test("a tampered hash is rejected as invalid", async () => {
    const ctx = makeDeps();
    const res = await handleTelegramLogin(loginRequest(signedSearch(["tamper=1"])), ctx.deps);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}/login?error=failed`);
    expect(ctx.upsertCalls).toEqual([]);
  });
});
