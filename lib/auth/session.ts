import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { env } from "@/lib/env";
import { getUserById } from "@/lib/db/queries";
import { hasAcceptedCurrentTerms } from "@/lib/legal/consent";
import type { UserRow } from "@/lib/db/types";
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  serializeSessionCookie,
  sessionCookieOptions,
  signSessionJwt,
  verifySessionJwt,
} from "./jwt";
import { EXPIRED_PATH, REQUEST_PATH_HEADER, acceptRedirectPath } from "./paths";

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

// The path the middleware stamped on the request, or null outside a request
// scope. Only ever used as a redirect hint; safeNextPath constrains it.
async function requestedPath(): Promise<string | null> {
  try {
    const store = await headers();
    const value = store.get(REQUEST_PATH_HEADER);
    return typeof value === "string" && value.startsWith("/") ? value : null;
  } catch {
    return null;
  }
}

// Pure acceptance decision for a verified session, so the gate is testable
// without mocking next/headers or the database. Null row means the session
// points at a user that is gone: expired, like a bad signature.
export type SessionGateResult =
  | { kind: "ok" }
  | { kind: "expired" }
  | { kind: "accept"; location: string };

export function sessionGateFor(row: UserRow | null, requestPath: string | null): SessionGateResult {
  if (row == null) return { kind: "expired" };
  if (!hasAcceptedCurrentTerms(row)) {
    return { kind: "accept", location: acceptRedirectPath(requestPath) };
  }
  return { kind: "ok" };
}

// Fail closed on every step: no session, a session pointing at a row that is
// gone, or a DB error all stop the page or action instead of rendering it. A
// signed-in user whose acceptance is missing or stale goes to /accept with a
// back-link to the page they wanted.
export async function requireSessionUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect(EXPIRED_PATH);
  const row = await getUserById(user.userId);
  const gate = sessionGateFor(row, await requestedPath());
  if (gate.kind === "expired") redirect(EXPIRED_PATH);
  if (gate.kind === "accept") redirect(gate.location);
  return user;
}
