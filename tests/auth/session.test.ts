import { describe, expect, test } from "bun:test";
import { SignJWT } from "jose";
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  createSessionToken,
  serializeSessionCookie,
  sessionCookieOptions,
  verifySessionToken,
} from "../../lib/auth/session";
import { signSessionJwt } from "../../lib/auth/jwt";

const SECRET = "test-session-secret-16ch";
const NOW = new Date("2026-10-31T09:00:00.000Z");
const TTL_SECONDS = SESSION_TTL_SECONDS;

function at(offsetSeconds: number): () => Date {
  const date = new Date(NOW.getTime() + offsetSeconds * 1000);
  return () => date;
}

function b64(object: object): string {
  return Buffer.from(JSON.stringify(object)).toString("base64url");
}

describe("createSessionToken and verifySessionToken", () => {
  test("roundtrip returns the userId", async () => {
    const token = await createSessionToken("user-1", { secret: SECRET, now: () => NOW });
    const user = await verifySessionToken(token, { secret: SECRET, now: () => NOW });
    expect(user).toEqual({ userId: "user-1" });
  });

  test("a tampered signature is rejected", async () => {
    const token = await createSessionToken("user-1", { secret: SECRET, now: () => NOW });
    const lastChar = token.endsWith("a") ? "b" : "a";
    const tampered = token.slice(0, -1) + lastChar;
    const user = await verifySessionToken(tampered, { secret: SECRET, now: () => NOW });
    expect(user).toBeNull();
  });

  test("an expired token is rejected using the injected now", async () => {
    const token = await createSessionToken("user-1", { secret: SECRET, now: () => NOW });
    const justInside = await verifySessionToken(token, {
      secret: SECRET,
      now: at(TTL_SECONDS - 1),
    });
    expect(justInside).toEqual({ userId: "user-1" });

    const justOutside = await verifySessionToken(token, {
      secret: SECRET,
      now: at(TTL_SECONDS + 1),
    });
    expect(justOutside).toBeNull();
  });

  test("a token signed with the wrong secret is rejected", async () => {
    const token = await createSessionToken("user-1", { secret: SECRET, now: () => NOW });
    const user = await verifySessionToken(token, {
      secret: "another-session-secret",
      now: () => NOW,
    });
    expect(user).toBeNull();
  });

  test("a token signed with alg none is rejected", async () => {
    const payload = {
      sub: "user-1",
      iat: Math.floor(NOW.getTime() / 1000),
      exp: Math.floor(NOW.getTime() / 1000) + 3600,
    };
    const noneToken = `${b64({ alg: "none" })}.${b64(payload)}.`;
    const user = await verifySessionToken(noneToken, { secret: SECRET, now: () => NOW });
    expect(user).toBeNull();
  });

  test("a token signed with HS512 is rejected", async () => {
    const seconds = Math.floor(NOW.getTime() / 1000);
    const hs512 = await new SignJWT({ sub: "user-1" })
      .setProtectedHeader({ alg: "HS512" })
      .setIssuedAt(seconds)
      .setExpirationTime(seconds + 3600)
      .sign(new TextEncoder().encode(SECRET));
    const user = await verifySessionToken(hs512, { secret: SECRET, now: () => NOW });
    expect(user).toBeNull();
  });

  test("a token without a sub claim is rejected", async () => {
    const seconds = Math.floor(NOW.getTime() / 1000);
    const noSub = await new SignJWT({ role: "student" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(seconds)
      .setExpirationTime(seconds + 3600)
      .sign(new TextEncoder().encode(SECRET));
    const user = await verifySessionToken(noSub, { secret: SECRET, now: () => NOW });
    expect(user).toBeNull();
  });

  test("missing or empty token is rejected without throwing", async () => {
    expect(await verifySessionToken(undefined, { secret: SECRET, now: () => NOW })).toBeNull();
    expect(await verifySessionToken(null, { secret: SECRET, now: () => NOW })).toBeNull();
    expect(await verifySessionToken("", { secret: SECRET, now: () => NOW })).toBeNull();
  });
});

describe("session cookie options", () => {
  test("secure only for https, httpOnly, lax, root path, 7 day max age", () => {
    const secure = sessionCookieOptions("https://settle.example.com");
    expect(secure).toEqual({
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: "/",
      maxAge: SESSION_TTL_SECONDS,
    });

    const local = sessionCookieOptions("http://localhost:3000");
    expect(local.secure).toBe(false);
    expect(local.httpOnly).toBe(true);
    expect(local.sameSite).toBe("lax");
    expect(local.path).toBe("/");
    expect(local.maxAge).toBe(7 * 24 * 3600);
  });

  test("serialized cookie carries the right attributes for each scheme", () => {
    const httpsCookie = serializeSessionCookie("jwt-value", "https://settle.example.com");
    expect(httpsCookie).toBe(
      "settle_session=jwt-value; Path=/; Max-Age=604800; HttpOnly; SameSite=Lax; Secure",
    );

    const httpCookie = serializeSessionCookie("jwt-value", "http://localhost:3000");
    expect(httpCookie).toBe("settle_session=jwt-value; Path=/; Max-Age=604800; HttpOnly; SameSite=Lax");
    expect(httpCookie).not.toContain("Secure");
  });

  test("constants match the spec", () => {
    expect(SESSION_COOKIE).toBe("settle_session");
    expect(SESSION_TTL_SECONDS).toBe(7 * 24 * 3600);
  });

  test("signSessionJwt produces a token verifySessionJwt accepts", async () => {
    const token = await signSessionJwt("user-2", SECRET, NOW, 60);
    expect(await verifySessionToken(token, { secret: SECRET, now: () => NOW })).toEqual({
      userId: "user-2",
    });
  });
});
