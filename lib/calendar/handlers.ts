// Thin route logic for the four /api/calendar endpoints. Pure over the
// injected deps (the Stripe webhook split): route files only build the real
// deps in lib/calendar/runtime.ts and pass the request pieces in. Nothing
// here imports server-only, env or the database, so tests run on fakes.
import { timingSafeEqual } from "node:crypto";
import { decryptToken, encryptToken } from "./crypto";
import { createGoogleClient } from "./google";
import {
  buildAuthUrl,
  clearOauthStateCookie,
  makePkce,
  makeState,
  OAUTH_STATE_COOKIE,
  serializeOauthStateCookie,
  signOauthState,
  verifyOauthState,
} from "./oauth";
import type { CalendarQueries } from "./queries";
import type { PlanTask, SyncSummary } from "./sync";

export type CalendarRouteConfig = {
  clientId: string;
  clientSecret: string;
  tokenKey: string;
  cronSecret: string;
  appBaseUrl: string;
  sessionSecret: string;
};

export type CalendarQueriesLike = Pick<
  CalendarQueries,
  | "getConnection"
  | "upsertConnection"
  | "deleteConnection"
  | "listActiveConnections"
  | "deleteLinksForUser"
>;

export type CalendarRouteDeps = {
  enabled: () => boolean;
  sessionUserId: () => Promise<string | null>;
  planForUser: (userId: string) => Promise<string>;
  config: () => CalendarRouteConfig;
  fetchFn: typeof fetch;
  queries: CalendarQueriesLike;
  listOpenTasks: (userId: string) => Promise<PlanTask[]>;
  runSync: (userId: string) => Promise<SyncSummary>;
  now: () => Date;
  log: (message: string) => void;
};

export const CALENDAR_CRON_LIMIT = 200;
export const CALENDAR_CRON_BUDGET_MS = 50 * 1000;

function notFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function redirectTo(location: string, cookie?: string): Response {
  const headers: Record<string, string> = {
    Location: location,
    "Cache-Control": "no-store",
  };
  if (cookie !== undefined) headers["Set-Cookie"] = cookie;
  return new Response(null, { status: 303, headers });
}

function readCookie(header: string | null | undefined, name: string): string | null {
  if (typeof header !== "string" || header.length === 0) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

function callbackUrl(appBaseUrl: string): string {
  return `${appBaseUrl}/api/calendar/callback`;
}

export async function handleCalendarConnect(
  deps: CalendarRouteDeps,
  url: string,
): Promise<Response> {
  void url;
  if (!deps.enabled()) return notFound();
  const userId = await deps.sessionUserId();
  if (userId == null) return redirectTo("/login");
  const plan = await deps.planForUser(userId);
  if (plan !== "pro") return redirectTo("/account?calendar=pro");
  const cfg = deps.config();
  const { verifier, challenge } = makePkce();
  const state = makeState();
  const token = await signOauthState({ state, verifier, userId }, cfg.sessionSecret, deps.now());
  const authUrl = buildAuthUrl({
    clientId: cfg.clientId,
    redirectUri: callbackUrl(cfg.appBaseUrl),
    state,
    codeChallenge: challenge,
  });
  return redirectTo(authUrl, serializeOauthStateCookie(token, cfg.appBaseUrl));
}

export async function handleCalendarCallback(
  deps: CalendarRouteDeps,
  url: string,
  cookieHeader: string | null | undefined,
): Promise<Response> {
  if (!deps.enabled()) return notFound();
  try {
    const userId = await deps.sessionUserId();
    if (userId == null) return redirectTo("/login");
    const cfg = deps.config();
    const clear = clearOauthStateCookie(cfg.appBaseUrl);
    const params = new URL(url).searchParams;
    const googleError = params.get("error");
    if (googleError === "access_denied") {
      return redirectTo("/account?calendar=denied", clear);
    }
    if (googleError != null) {
      return redirectTo("/account?calendar=error", clear);
    }
    const code = params.get("code");
    const paramState = params.get("state");
    const cookieToken = readCookie(cookieHeader, OAUTH_STATE_COOKIE);
    const verified = await verifyOauthState(cookieToken, cfg.sessionSecret, deps.now(), userId);
    if (code == null || paramState == null || verified == null || paramState !== verified.state) {
      return redirectTo("/account?calendar=error", clear);
    }
    const google = createGoogleClient({
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      fetch: deps.fetchFn,
    });
    const tokens = await google.exchangeCode({
      code,
      codeVerifier: verified.verifier,
      redirectUri: callbackUrl(cfg.appBaseUrl),
    });
    if (tokens.refreshToken == null) {
      return redirectTo("/account?calendar=error", clear);
    }
    const refreshTokenEnc = encryptToken(tokens.refreshToken, cfg.tokenKey);
    // Connecting again keeps the existing Settle calendar instead of leaving
    // an orphan behind in the person's Google account.
    const existing = await deps.queries.getConnection(userId);
    await deps.queries.upsertConnection({
      userId,
      googleCalendarId: existing?.google_calendar_id ?? null,
      refreshTokenEnc,
      status: "active",
    });
    try {
      await deps.runSync(userId);
    } catch {
      // The first sync retries on the next change or cron run.
    }
    return redirectTo("/account?calendar=connected", clear);
  } catch {
    deps.log("[calendar] callback failed, redirecting to the account page");
    let clear: string | undefined;
    try {
      clear = clearOauthStateCookie(deps.config().appBaseUrl);
    } catch {
      clear = undefined;
    }
    return redirectTo("/account?calendar=error", clear);
  }
}

// The Account page posts here. The guarded deletion actions carry no origin
// check, so this route has none either; the session cookie is the credential.
export async function handleCalendarDisconnect(deps: CalendarRouteDeps): Promise<Response> {
  if (!deps.enabled()) return notFound();
  const userId = await deps.sessionUserId();
  if (userId == null) return redirectTo("/login");
  const cfg = deps.config();
  try {
    const connection = await deps.queries.getConnection(userId);
    if (connection?.refresh_token_enc) {
      try {
        const refreshToken = decryptToken(connection.refresh_token_enc, cfg.tokenKey);
        const google = createGoogleClient({
          clientId: cfg.clientId,
          clientSecret: cfg.clientSecret,
          fetch: deps.fetchFn,
        });
        let accessToken: string | null = null;
        try {
          accessToken = (await google.refreshAccessToken(refreshToken)).accessToken;
        } catch {
          accessToken = null;
        }
        if (accessToken != null && connection.google_calendar_id != null) {
          try {
            await google.deleteCalendar(accessToken, connection.google_calendar_id);
          } catch {
            // Already gone or unreachable: links still go below.
          }
        }
        await google.revokeToken(refreshToken);
      } catch {
        // Best effort Google cleanup: the rows still go below.
      }
    }
  } catch {
    // A failed connection read falls through to the deletes below.
  }
  try {
    await deps.queries.deleteLinksForUser(userId);
    await deps.queries.deleteConnection(userId);
  } catch {
    deps.log("[calendar] disconnect cleanup failed, redirecting to the account page");
    return redirectTo("/account?calendar=error");
  }
  return redirectTo("/account?calendar=disconnected");
}

function cronAuthorized(header: string | null | undefined, secret: string): boolean {
  if (typeof header !== "string" || secret.length === 0) return false;
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const provided = Buffer.from(header.slice(prefix.length), "utf8");
  const expected = Buffer.from(secret, "utf8");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export async function handleCalendarCron(
  deps: CalendarRouteDeps,
  authHeader: string | null | undefined,
): Promise<Response> {
  if (!deps.enabled()) return notFound();
  if (!cronAuthorized(authHeader, deps.config().cronSecret)) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  const connections = await deps.queries.listActiveConnections(CALENDAR_CRON_LIMIT);
  const deadline = deps.now().getTime() + CALENDAR_CRON_BUDGET_MS;
  let users = 0;
  let created = 0;
  let patched = 0;
  let removed = 0;
  let failed = 0;
  for (const connection of connections) {
    if (deps.now().getTime() > deadline) break;
    users += 1;
    try {
      const summary = await deps.runSync(connection.user_id);
      created += summary.created;
      patched += summary.patched;
      removed += summary.removed;
      failed += summary.failed;
    } catch {
      failed += 1;
    }
  }
  return Response.json({ users, created, patched, removed, failed });
}
