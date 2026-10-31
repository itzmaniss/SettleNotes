// Pure signed-token and cookie helpers for the consent handoff: the Telegram
// login route stamps an unaccepted (or stale) visitor into a 10 minute cookie
// so the /accept page and its server action can finish the job without trusting
// any hidden form field. Same discipline as lib/auth/jwt.ts: no server-only,
// no env imports, the secret is always injected, so the edge could import this
// too if it ever needed to.

import { SignJWT, jwtVerify } from "jose";

export const CONSENT_COOKIE = "settle_consent";
export const CONSENT_TTL_SECONDS = 10 * 60;
// Pins what the token may be used for, so a session style token can never be
// replayed here and a consent token can never be replayed as a session.
export const CONSENT_PURPOSE = "consent";

export type ConsentClaims = {
  /** Telegram numeric user id. */
  tid: number;
  /** First name from the verified widget payload, or null. */
  fn: string | null;
};

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function createConsentToken(
  claims: ConsentClaims,
  secret: string,
  now: Date,
): Promise<string> {
  const seconds = Math.floor(now.getTime() / 1000);
  return new SignJWT({ tid: claims.tid, fn: claims.fn, purpose: CONSENT_PURPOSE })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(seconds)
    .setExpirationTime(seconds + CONSENT_TTL_SECONDS)
    .sign(secretKey(secret));
}

export async function verifyConsentToken(
  token: string | undefined | null,
  secret: string | undefined,
  now: Date,
): Promise<ConsentClaims | null> {
  if (!token || !secret) return null;
  try {
    const { payload, protectedHeader } = await jwtVerify(token, secretKey(secret), {
      algorithms: ["HS256"],
      currentDate: now,
    });
    if (protectedHeader.alg !== "HS256") return null;
    if (payload.purpose !== CONSENT_PURPOSE) return null;
    // Telegram ids are positive safe integers; anything else is malformed.
    if (typeof payload.tid !== "number" || !Number.isSafeInteger(payload.tid) || payload.tid <= 0) {
      return null;
    }
    const fn = payload.fn;
    if (fn !== null && typeof fn !== "string") return null;
    return { tid: payload.tid, fn };
  } catch {
    return null;
  }
}

export type ConsentCookieOptions = {
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

// Cookie flags follow the origin scheme exactly like the session cookie, so
// Safari keeps working on http://localhost.
export function consentCookieOptions(appBaseUrl: string): ConsentCookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: isHttps(appBaseUrl),
    path: "/",
    maxAge: CONSENT_TTL_SECONDS,
  };
}

export function serializeConsentCookie(token: string, appBaseUrl: string): string {
  const opts = consentCookieOptions(appBaseUrl);
  const parts = [
    `${CONSENT_COOKIE}=${token}`,
    `Path=${opts.path}`,
    `Max-Age=${opts.maxAge}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

// Max-Age=0 is how a cookie is actually removed across browsers.
export function clearedConsentCookie(appBaseUrl: string): string {
  const opts = consentCookieOptions(appBaseUrl);
  const parts = [
    `${CONSENT_COOKIE}=`,
    `Path=${opts.path}`,
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}
