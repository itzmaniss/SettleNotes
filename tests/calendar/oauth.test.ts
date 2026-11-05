import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  buildAuthUrl,
  clearOauthStateCookie,
  GOOGLE_CALENDAR_SCOPE,
  makePkce,
  makeState,
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_COOKIE_PATH,
  serializeOauthStateCookie,
  signOauthState,
  verifyOauthState,
  type OauthState,
} from "../../lib/calendar/oauth";

const SECRET = "test-oauth-secret-0123456789abcdef";
const NOW = new Date("2026-11-05T00:00:00.000Z");
const STATE: OauthState = { state: "csrf-1", verifier: "verifier-1", userId: "user-1" };

describe("buildAuthUrl", () => {
  test("carries the exact scope and offline consent parameters", () => {
    const url = new URL(
      buildAuthUrl({
        clientId: "cid",
        redirectUri: "https://app.example/api/calendar/callback",
        state: "csrf-1",
        codeChallenge: "challenge-1",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/auth");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://app.example/api/calendar/callback",
    );
    expect(url.searchParams.get("scope")).toBe(GOOGLE_CALENDAR_SCOPE);
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/calendar.app.created");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("include_granted_scopes")).toBe("false");
    expect(url.searchParams.get("state")).toBe("csrf-1");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });
});

describe("makePkce", () => {
  test("verifier length sits in range and the challenge matches S256", () => {
    const { verifier, challenge } = makePkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9\-_]+$/);
    const expected = createHash("sha256").update(verifier, "ascii").digest("base64url");
    expect(challenge).toBe(expected);
  });

  test("two pairs never share a verifier", () => {
    expect(makePkce().verifier).not.toBe(makePkce().verifier);
    expect(makeState()).not.toBe(makeState());
  });
});

describe("oauth state cookie", () => {
  test("a signed state verifies for the same user", async () => {
    const token = await signOauthState(STATE, SECRET, NOW);
    expect(await verifyOauthState(token, SECRET, NOW, "user-1")).toEqual(STATE);
  });

  test("expired states are rejected", async () => {
    const token = await signOauthState(STATE, SECRET, NOW);
    const late = new Date(NOW.getTime() + 11 * 60 * 1000);
    expect(await verifyOauthState(token, SECRET, late, "user-1")).toBeNull();
  });

  test("tampered tokens and wrong secrets are rejected", async () => {
    const token = await signOauthState(STATE, SECRET, NOW);
    const tampered = token.slice(0, -2) + (token.endsWith("aa") ? "bb" : "aa");
    expect(await verifyOauthState(tampered, SECRET, NOW, "user-1")).toBeNull();
    expect(await verifyOauthState(token, "wrong-secret-0123456789abcdef", NOW, "user-1")).toBeNull();
  });

  test("a state for another user is rejected", async () => {
    const token = await signOauthState(STATE, SECRET, NOW);
    expect(await verifyOauthState(token, SECRET, NOW, "user-2")).toBeNull();
  });

  test("missing token or secret is rejected without throwing", async () => {
    expect(await verifyOauthState(null, SECRET, NOW, "user-1")).toBeNull();
    expect(await verifyOauthState(undefined, SECRET, NOW, "user-1")).toBeNull();
    expect(await verifyOauthState("token", undefined, NOW, "user-1")).toBeNull();
  });

  test("the cookie is httpOnly Lax on the calendar path, Secure only on https", () => {
    const plain = serializeOauthStateCookie("tok", "http://localhost:3000");
    expect(plain).toContain(`${OAUTH_STATE_COOKIE}=tok`);
    expect(plain).toContain(`Path=${OAUTH_STATE_COOKIE_PATH}`);
    expect(plain).toContain("HttpOnly");
    expect(plain).toContain("SameSite=Lax");
    expect(plain).not.toContain("Secure");

    const secure = serializeOauthStateCookie("tok", "https://app.example");
    expect(secure).toContain("Secure");

    const cleared = clearOauthStateCookie("https://app.example");
    expect(cleared).toContain(`${OAUTH_STATE_COOKIE}=`);
    expect(cleared).toContain(`Path=${OAUTH_STATE_COOKIE_PATH}`);
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain("Secure");
  });
});
