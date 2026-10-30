import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { env } from "@/lib/env";
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  serializeSessionCookie,
  sessionCookieOptions,
  signSessionJwt,
  verifySessionJwt,
} from "./jwt";
import { EXPIRED_PATH } from "./paths";

// Re-exported so callers get the whole session surface from this module while
// middleware keeps importing the edge safe primitives from ./jwt.
export { SESSION_COOKIE, SESSION_TTL_SECONDS, serializeSessionCookie, sessionCookieOptions };

export type SessionUser = { userId: string };

export async function createSessionToken(
  userId: string,
  opts: { secret?: string; now?: () => Date } = {},
): Promise<string> {
  const secret = opts.secret ?? env.SESSION_SECRET;
  const now = (opts.now ?? (() => new Date()))();
  return signSessionJwt(userId, secret, now, SESSION_TTL_SECONDS);
}

export async function verifySessionToken(
  token: string | undefined | null,
  opts: { secret?: string; now?: () => Date } = {},
): Promise<SessionUser | null> {
  const secret = opts.secret ?? env.SESSION_SECRET;
  const now = (opts.now ?? (() => new Date()))();
  return verifySessionJwt(token, secret, now);
}

// For server components.
export async function getSessionUser(): Promise<SessionUser | null> {
  const store = await cookies();
  return verifySessionToken(store.get(SESSION_COOKIE)?.value);
}

export async function requireSessionUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect(EXPIRED_PATH);
  return user;
}
