import { describe, expect, test } from "bun:test";
import {
  CONSENT_COOKIE,
  CONSENT_PURPOSE,
  CONSENT_TTL_SECONDS,
  clearedConsentCookie,
  consentCookieOptions,
  createConsentToken,
  serializeConsentCookie,
  verifyConsentToken,
} from "../../lib/auth/consent-cookie";
import { signSessionJwt } from "../../lib/auth/jwt";
const SECRET = "test-consent-secret-16";
const NOW = new Date("2026-10-31T09:00:00.000Z");

function at(offsetSeconds: number): Date {
  return new Date(NOW.getTime() + offsetSeconds * 1000);
}

describe("createConsentToken and verifyConsentToken", () => {
  test("roundtrip returns the claims", async () => {
    const token = await createConsentToken({ tid: 900000001, fn: "Wei" }, SECRET, NOW);
    const claims = await verifyConsentToken(token, SECRET, at(1));
    expect(claims).toEqual({ tid: 900000001, fn: "Wei" });
  });

  test("the token carries the consent purpose and the 10 minute expiry", async () => {
    const token = await createConsentToken({ tid: 7, fn: null }, SECRET, NOW);
    const inside = await verifyConsentToken(token, SECRET, at(CONSENT_TTL_SECONDS - 1));
    expect(inside).toEqual({ tid: 7, fn: null });
    const outside = await verifyConsentToken(token, SECRET, at(CONSENT_TTL_SECONDS + 1));
    expect(outside).toBeNull();
  });

  test("a tampered token is rejected", async () => {
    const token = await createConsentToken({ tid: 7, fn: null }, SECRET, NOW);
    const lastChar = token.endsWith("a") ? "b" : "a";
    expect(await verifyConsentToken(token.slice(0, -1) + lastChar, SECRET, at(1))).toBeNull();
  });

  test("a token signed with the wrong secret is rejected", async () => {
    const token = await createConsentToken({ tid: 7, fn: null }, SECRET, NOW);
    expect(await verifyConsentToken(token, "another-secret-value", at(1))).toBeNull();
  });

  test("a session style token with the wrong purpose is rejected", async () => {
    // A real session JWT has sub and no purpose; it must never open /accept.
    const sessionToken = await signSessionJwt("user-1", SECRET, NOW, 3600);
    expect(await verifyConsentToken(sessionToken, SECRET, at(1))).toBeNull();
  });

  test("a token with the session cookie purpose explicitly forged is still rejected", async () => {
    const { SignJWT } = await import("jose");
    const seconds = Math.floor(NOW.getTime() / 1000);
    const forged = await new SignJWT({ tid: 7, fn: null, purpose: "session" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(seconds)
      .setExpirationTime(seconds + 600)
      .sign(new TextEncoder().encode(SECRET));
    expect(await verifyConsentToken(forged, SECRET, at(1))).toBeNull();
    expect(CONSENT_PURPOSE).toBe("consent");
  });

  test("a malformed tid (float, zero, negative) is rejected", async () => {
    const { SignJWT } = await import("jose");
    const seconds = Math.floor(NOW.getTime() / 1000);
    for (const bad of [0, -5, 1.5, Number.NaN]) {
      const token = await new SignJWT({ tid: bad, fn: null, purpose: CONSENT_PURPOSE })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt(seconds)
        .setExpirationTime(seconds + 600)
        .sign(new TextEncoder().encode(SECRET));
      expect(await verifyConsentToken(token, SECRET, at(1)), `tid ${bad}`).toBeNull();
    }
  });

  test("missing token or secret returns null instead of throwing", async () => {
    expect(await verifyConsentToken(undefined, SECRET, NOW)).toBeNull();
    expect(await verifyConsentToken(null, SECRET, NOW)).toBeNull();
    expect(await verifyConsentToken("", undefined, NOW)).toBeNull();
  });
});

describe("consent cookie serialization", () => {
  test("the cookie name is settle_consent", () => {
    expect(CONSENT_COOKIE).toBe("settle_consent");
    expect(CONSENT_TTL_SECONDS).toBe(600);
  });

  test("flags follow the origin scheme exactly like the session cookie", () => {
    const cookie = serializeConsentCookie("jwt-value", "https://settle.example.com");
    expect(cookie).toContain("settle_consent=jwt-value");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=600");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");

    const local = serializeConsentCookie("jwt-value", "http://localhost:3000");
    expect(local).not.toContain("Secure");
  });

  test("consentCookieOptions matches the serialized shape", () => {
    expect(consentCookieOptions("https://settle.example.com")).toEqual({
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: "/",
      maxAge: 600,
    });
    expect(consentCookieOptions("http://localhost:3000").secure).toBe(false);
  });

  test("clearedConsentCookie uses Max-Age=0", () => {
    const cleared = clearedConsentCookie("https://settle.example.com");
    expect(cleared).toContain("settle_consent=");
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain("HttpOnly");
    expect(cleared).toContain("Secure");
  });
});
