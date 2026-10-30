// Pure session JWT and cookie helpers. No server-only, no env imports: the
// edge middleware imports this file too, and every caller injects its secret.
import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE = "settle_session";
export const SESSION_ALG = "HS256";
export const SESSION_TTL_SECONDS = 7 * 24 * 3600;

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signSessionJwt(
  userId: string,
  secret: string,
  now: Date,
  ttlSeconds: number,
): Promise<string> {
  const seconds = Math.floor(now.getTime() / 1000);
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: SESSION_ALG })
    .setIssuedAt(seconds)
    .setExpirationTime(seconds + ttlSeconds)
    .sign(secretKey(secret));
}

export async function verifySessionJwt(
  token: string | undefined | null,
  secret: string | undefined,
  now: Date,
): Promise<{ userId: string } | null> {
  if (!token || !secret) return null;
  try {
    // algorithms pins the allowlist, so "none" and HS512 tokens die here, and
    // currentDate makes expiry deterministic for injected clocks.
    const { payload, protectedHeader } = await jwtVerify(token, secretKey(secret), {
      algorithms: [SESSION_ALG],
      currentDate: now,
    });
    if (protectedHeader.alg !== SESSION_ALG) return null;
    if (typeof payload.sub !== "string" || payload.sub.length === 0) return null;
    return { userId: payload.sub };
  } catch {
    return null;
  }
}

export type SessionCookieOptions = {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: "/";
  maxAge: number;
};

function isHttps(base: string): boolean {
  try {
    return new URL(base).protocol === "https:";
  } catch {
    return false;
  }
}

// Safari refuses Secure cookies on http://localhost, so `secure` follows the
// actual URL scheme and local dev keeps working.
export function sessionCookieOptions(appBaseUrl: string): SessionCookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: isHttps(appBaseUrl),
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  };
}

export function serializeSessionCookie(token: string, appBaseUrl: string): string {
  const opts = sessionCookieOptions(appBaseUrl);
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    `Path=${opts.path}`,
    `Max-Age=${opts.maxAge}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}
