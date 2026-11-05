// Pure Google OAuth helpers for Calendar sync: auth URL, PKCE, and the
// signed state cookie. No server-only, no env imports; every caller injects
// its secrets, so tests run this file directly.
import { createHash, randomBytes } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

export const OAUTH_STATE_COOKIE = "settle_cal_oauth";
export const OAUTH_STATE_TTL_SECONDS = 10 * 60;
export const OAUTH_STATE_COOKIE_PATH = "/api/calendar";
export const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.app.created";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/auth";

export type BuildAuthUrlInput = {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
};

export function buildAuthUrl(input: BuildAuthUrlInput): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: GOOGLE_CALENDAR_SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

function toBase64Url(buf: Buffer): string {
  return buf.toString("base64url");
}

// Random CSRF state, 16 bytes of entropy.
export function makeState(): string {
  return toBase64Url(randomBytes(16));
}

export type PkcePair = {
  verifier: string;
  challenge: string;
};

// 32 random bytes encode to exactly 43 base64url characters, inside the
// 43 to 128 range Google accepts. The challenge is the S256 hash of that.
export function makePkce(): PkcePair {
  const verifier = toBase64Url(randomBytes(32));
  const challenge = toBase64Url(createHash("sha256").update(verifier, "ascii").digest());
  return { verifier, challenge };
}

export type OauthState = {
  state: string;
  verifier: string;
  userId: string;
};

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signOauthState(
  input: OauthState,
  secret: string,
  now: Date = new Date(),
): Promise<string> {
  const seconds = Math.floor(now.getTime() / 1000);
  return new SignJWT({ state: input.state, verifier: input.verifier, sub: input.userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(seconds)
    .setExpirationTime(seconds + OAUTH_STATE_TTL_SECONDS)
    .sign(secretKey(secret));
}

// Null on any problem: bad signature, expiry, wrong shape, or a state that
// was issued for a different user. Never throws.
export async function verifyOauthState(
  token: string | undefined | null,
  secret: string | undefined,
  now: Date,
  userId: string,
): Promise<OauthState | null> {
  if (!token || !secret) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey(secret), {
      algorithms: ["HS256"],
      currentDate: now,
    });
    if (
      typeof payload.state !== "string" ||
      payload.state.length === 0 ||
      typeof payload.verifier !== "string" ||
      payload.verifier.length === 0 ||
      payload.sub !== userId
    ) {
      return null;
    }
    return { state: payload.state, verifier: payload.verifier, userId: payload.sub };
  } catch {
    return null;
  }
}

function isHttps(base: string): boolean {
  try {
    return new URL(base).protocol === "https:";
  } catch {
    return false;
  }
}

export type OauthStateCookieOptions = {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: string;
  maxAge: number;
};

export function oauthStateCookieOptions(appBaseUrl: string): OauthStateCookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: isHttps(appBaseUrl),
    path: OAUTH_STATE_COOKIE_PATH,
    maxAge: OAUTH_STATE_TTL_SECONDS,
  };
}

export function serializeOauthStateCookie(token: string, appBaseUrl: string): string {
  const opts = oauthStateCookieOptions(appBaseUrl);
  const parts = [
    `${OAUTH_STATE_COOKIE}=${token}`,
    `Path=${opts.path}`,
    `Max-Age=${opts.maxAge}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearOauthStateCookie(appBaseUrl: string): string {
  const opts = oauthStateCookieOptions(appBaseUrl);
  const parts = [
    `${OAUTH_STATE_COOKIE}=`,
    `Path=${opts.path}`,
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}
