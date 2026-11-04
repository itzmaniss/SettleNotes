import { describe, expect, test } from "bun:test";
import { createSessionToken, sessionGateFor, verifySessionToken } from "../../lib/auth/session";
import { clearSessionCookie, type CookieStoreLike } from "../../lib/account/session-cookie";

const SECRET = "account-test-secret-16ch";
const NOW = new Date("2026-11-28T01:00:00.000Z");
const USER = "ccccccc1-0000-4000-8000-000000000003";

type Captured = Parameters<CookieStoreLike["set"]>[0];

function fakeStore() {
  const calls: Captured[] = [];
  const store: CookieStoreLike = {
    set: (options) => {
      calls.push(options);
    },
  };
  return { store, calls };
}

describe("clearSessionCookie", () => {
  test("clears the session cookie with the same attributes, Max-Age 0", () => {
    const { store, calls } = fakeStore();
    clearSessionCookie(store, "https://settle.example.com");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      name: "settle_session",
      value: "",
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      maxAge: 0,
    });
  });

  test("an http base URL keeps the cookie non Secure, exactly like setting it", () => {
    const { store, calls } = fakeStore();
    clearSessionCookie(store, "http://localhost:3000");
    expect(calls[0]?.secure).toBe(false);
    expect(calls[0]?.name).toBe("settle_session");
    expect(calls[0]?.path).toBe("/");
    expect(calls[0]?.maxAge).toBe(0);
  });
});

describe("a deleted user's cookie is rejected", () => {
  // After a successful erase the users row is gone, but the signed cookie in
  // an old browser tab still verifies. The rejection lives in the session
  // gate: requireSessionUser looks the user up and fails closed, so the
  // cookie alone never opens the dashboard.
  test("the cookie verifies, but a missing user row expires the session", async () => {
    const token = await createSessionToken(USER, { secret: SECRET, now: () => NOW });
    const session = await verifySessionToken(token, { secret: SECRET, now: () => NOW });
    expect(session).toEqual({ userId: USER });

    const gate = sessionGateFor(null, "/dashboard");
    expect(gate).toEqual({ kind: "expired" });
  });

  test("the same gate rejects a missing row on the account path too", () => {
    expect(sessionGateFor(null, "/account")).toEqual({ kind: "expired" });
    expect(sessionGateFor(null, "/account/export")).toEqual({ kind: "expired" });
  });
});
