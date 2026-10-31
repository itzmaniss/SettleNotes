// Telegram Login Widget verification and web login, keyed on the immutable
// numeric Telegram user id. Pure logic lives here with injected deps; the
// route (app/auth/telegram/route.ts) stays a thin wrapper.
//
// Identity rule: an account is found and linked ONLY by users.telegram_user_id.
// Usernames and names can change at any time and are never used to look up,
// match or link an account. A person who moves to a new Telegram account gets
// a new account; merging is a manual operator task.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { upsertUser, type UpsertUserInput } from "@/lib/db/queries";
import { getUserByTelegramId } from "@/lib/clarify/queries";
import type { UserRow } from "@/lib/db/types";
import { hasAcceptedCurrentTerms } from "@/lib/legal/consent";
import { getAccessPolicy, isAccessAllowed, type AccessPolicy } from "@/lib/telegram/access";
import { createConsentToken, serializeConsentCookie } from "./consent-cookie";
import { publicOrigin } from "./origin";
import { acceptRedirectPath, safeNextPath } from "./paths";
import { createSessionToken, serializeSessionCookie } from "./session";

// Shared implementation; re-exported so existing callers and tests keep one
// import surface.
export { safeNextPath };

const WIDGET_FIELDS = [
  "id",
  "first_name",
  "last_name",
  "username",
  "photo_url",
  "auth_date",
  "hash",
] as const satisfies readonly string[];

// Replay window: a widget callback older than 5 minutes or more than 1 minute
// in the future is rejected, so a stolen callback URL dies fast.
const MAX_AGE_SECONDS = 5 * 60;
const MAX_SKEW_SECONDS = 60;

export type TelegramLoginParams = Record<string, string | string[] | undefined>;

export type TelegramLoginVerifyResult =
  | { ok: true; user: { id: number; firstName: string | null } }
  | { ok: false; reason: "bad_hash" | "expired" | "malformed" };

// All received fields except hash, as key=value sorted alphabetically by key
// and joined with newlines. Exported for tests; this exact string is what the
// HMAC is computed over.
export function buildDataCheckString(fields: Record<string, string>): string {
  return Object.keys(fields)
    .filter((key) => key !== "hash")
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join("\n");
}

function expectedHash(fields: Record<string, string>, botToken: string): string {
  // Per Telegram's spec: HMAC_SHA256 keyed by the raw SHA256 of the bot token.
  const secret = createHash("sha256").update(botToken, "utf8").digest();
  return createHmac("sha256", secret)
    .update(buildDataCheckString(fields), "utf8")
    .digest("hex");
}

function hashesMatch(expected: string, given: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(given, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Telegram sends one value per key; a repeated key means the query was
// tampered with. Returns null when any key has zero or several values.
function flattenParams(params: TelegramLoginParams): Record<string, string> | null {
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length !== 1) return null;
      flat[key] = value[0];
    } else {
      flat[key] = value;
    }
  }
  return flat;
}

export function verifyTelegramLogin(
  params: TelegramLoginParams,
  botToken: string,
  now: Date,
): TelegramLoginVerifyResult {
  const flat = flattenParams(params);
  if (flat === null) return { ok: false, reason: "malformed" };

  // Only the documented widget fields are accepted; anything else is malformed.
  for (const key of Object.keys(flat)) {
    if (!(WIDGET_FIELDS as readonly string[]).includes(key)) {
      return { ok: false, reason: "malformed" };
    }
  }

  const { id, auth_date: authDate, hash, first_name: firstName } = flat;
  if (id === undefined || authDate === undefined || hash === undefined) {
    return { ok: false, reason: "malformed" };
  }
  // Decimal digits only: rejects floats, negatives, zero, NaN and ids beyond
  // the safe integer range before they ever reach the database.
  if (!/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id))) {
    return { ok: false, reason: "malformed" };
  }
  // Telegram always sends lowercase hex; anything else is malformed.
  if (!/^[0-9a-f]{64}$/.test(hash)) return { ok: false, reason: "malformed" };
  if (!/^[0-9]+$/.test(authDate) || !Number.isSafeInteger(Number(authDate))) {
    return { ok: false, reason: "malformed" };
  }

  const nowSeconds = Math.floor(now.getTime() / 1000);
  const authSeconds = Number(authDate);
  if (authSeconds < nowSeconds - MAX_AGE_SECONDS || authSeconds > nowSeconds + MAX_SKEW_SECONDS) {
    return { ok: false, reason: "expired" };
  }

  if (!hashesMatch(expectedHash(flat, botToken), hash)) {
    return { ok: false, reason: "bad_hash" };
  }
  return { ok: true, user: { id: Number(id), firstName: firstName ?? null } };
}

export type TelegramLoginTarget = { botUsername: string; authUrl: string };

// Decides whether the widget can render at all: BotFather only lets the widget
// run on the registered https domain, so http (local dev) or a missing bot
// username gets the bot fallback instead of a widget that never works.
export function telegramLoginTarget(
  appBaseUrl: unknown,
  botUsername: unknown,
): TelegramLoginTarget | null {
  const handle = typeof botUsername === "string" ? botUsername.trim().replace(/^@/, "") : "";
  if (handle === "") return null;
  let base: URL;
  try {
    base = new URL(typeof appBaseUrl === "string" ? appBaseUrl.trim() : "");
  } catch {
    return null;
  }
  if (base.protocol !== "https:") return null;
  return { botUsername: handle, authUrl: `${base.href.replace(/\/+$/, "")}/auth/telegram` };
}

// Student facing copy for the login page. Plain, warm, free of em or en
// dashes. When the widget cannot render, the bot line doubles as the fallback
// instruction so the page never repeats the same sentence twice.
export const LOGIN_PAGE_INTRO =
  "Use the same Telegram account you chat with Settle on. Your tasks and plan are already there.";

export const LOGIN_PAGE_BOT_LINE =
  "Prefer to stay in Telegram? Send /dashboard to the bot and I will send you a link.";

export const LOGIN_ERROR_BANNERS: Record<string, string> = {
  failed: "That login did not work. Please try again.",
  not_invited: "This account is not on the invite list yet.",
};

// Unknown or repeated error values show no banner at all.
export function loginErrorBanner(error: unknown): string | null {
  if (typeof error !== "string") return null;
  return LOGIN_ERROR_BANNERS[error] ?? null;
}

export type TelegramLoginDeps = {
  botToken: string;
  /** Access policy from lib/telegram/access.getAccessPolicy (bare id list ok). */
  access: AccessPolicy | number[];
  /** Real impl resolves to lib/clarify/queries.getUserByTelegramId. */
  getUserByTelegramId: (telegramUserId: number) => Promise<UserRow | null>;
  /** Real impl is lib/db/queries.upsertUser. */
  upsertUser: (input: UpsertUserInput) => Promise<{ id: string }>;
  /** Real impl is createSessionToken, the same session the magic link issues. */
  createSession: (userId: string) => Promise<string>;
  // Public origin every redirect is built from; never request.url (behind a
  // proxy that is the container's internal address).
  appBaseUrl: string;
  // Signs the short lived consent handoff cookie; same secret as sessions.
  consentSecret: string;
  now: Date;
};

export type TelegramLoginOutcome =
  | { kind: "ok"; userId: string; sessionToken: string }
  // Verified visitor without a current acceptance: no row is touched here, the
  // /accept page and its action finish the job.
  | { kind: "consent"; consentToken: string }
  | { kind: "denied" }
  | { kind: "invalid" };

export async function completeTelegramLogin(
  deps: TelegramLoginDeps,
  params: TelegramLoginParams,
): Promise<TelegramLoginOutcome> {
  const verified = verifyTelegramLogin(params, deps.botToken, deps.now);
  if (!verified.ok) return { kind: "invalid" };

  // Same access policy as the bot (lib/telegram/access). Open mode admits any
  // verified login; otherwise the numeric Telegram id must be on the list, so
  // a stranger cannot create an account by logging in from the web. The hash
  // check above always runs first, in both modes.
  if (!isAccessAllowed(verified.user.id, deps.access)) return { kind: "denied" };

  const existing = await deps.getUserByTelegramId(verified.user.id);
  // Affirmative acceptance before any account write: a visitor with no row, or
  // one whose acceptance is missing or older than TERMS_VERSION, is sent to
  // /accept instead. Their identity rides in a 10 minute signed cookie.
  if (existing == null || !hasAcceptedCurrentTerms(existing)) {
    const consentToken = await createConsentToken(
      { tid: verified.user.id, fn: verified.user.firstName },
      deps.consentSecret,
      deps.now,
    );
    return { kind: "consent", consentToken };
  }
  // Accepted: the row exists, so the upsert only refreshes name and chat id.
  // It carries no terms fields, so it can never clear the stored acceptance.
  const row = await deps.upsertUser({
    telegramUserId: verified.user.id,
    telegramChatId: existing.telegram_chat_id,
    firstName: verified.user.firstName,
  });
  const sessionToken = await deps.createSession(row.id);
  return { kind: "ok", userId: row.id, sessionToken };
}

function loginRedirect(location: string, cookie?: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      Location: location,
      // The signed query is a bearer payload: never cached, never leaked to
      // the next site via Referer.
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      ...(cookie ? { "Set-Cookie": cookie } : {}),
    },
  });
}

function absolute(path: string, origin: string): string {
  try {
    return new URL(path, origin).toString();
  } catch {
    return path;
  }
}

// The GET logic behind app/auth/telegram, with deps injected so tests run
// without env, network or database. Nothing here logs the query string.
export async function handleTelegramLogin(request: Request, deps: TelegramLoginDeps): Promise<Response> {
  // Every redirect is built from the configured public origin; request.url is
  // only the fallback for local dev because behind Caddy it is 0.0.0.0:3000.
  const origin = publicOrigin(deps.appBaseUrl, request.url);
  const url = new URL(request.url);
  const params: TelegramLoginParams = {};
  for (const key of new Set(url.searchParams.keys())) {
    // next is our own navigation hint and never part of the signed widget
    // payload, so it is kept out of verification (safeNextPath constrains it).
    if (key === "next") continue;
    const values = url.searchParams.getAll(key);
    params[key] = values.length === 1 ? values[0] : values;
  }

  const outcome = await completeTelegramLogin(deps, params);
  if (outcome.kind === "ok") {
    // Same cookie flags as the magic link route: flags follow the origin scheme.
    const cookie = serializeSessionCookie(outcome.sessionToken, origin);
    return loginRedirect(absolute(safeNextPath(url.searchParams.get("next")), origin), cookie);
  }
  if (outcome.kind === "consent") {
    const cookie = serializeConsentCookie(outcome.consentToken, origin);
    return loginRedirect(absolute(acceptRedirectPath(url.searchParams.get("next")), origin), cookie);
  }
  const error = outcome.kind === "denied" ? "not_invited" : "failed";
  return loginRedirect(absolute(`/login?error=${error}`, origin));
}

// Real deps resolved lazily so importing this module never reads env and never
// touches the database (same pattern as lib/auth/tokens.ts).
export function realTelegramLoginDeps(): TelegramLoginDeps {
  return {
    get botToken() {
      return env.TELEGRAM_BOT_TOKEN;
    },
    get access() {
      return getAccessPolicy();
    },
    get getUserByTelegramId() {
      return getUserByTelegramId;
    },
    get upsertUser() {
      return upsertUser;
    },
    get createSession() {
      return (userId: string) => createSessionToken(userId);
    },
    get appBaseUrl() {
      return env.APP_BASE_URL;
    },
    get consentSecret() {
      return env.SESSION_SECRET;
    },
    now: new Date(),
  };
}
