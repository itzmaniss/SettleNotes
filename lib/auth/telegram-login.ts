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
import { isAllowedUser } from "@/lib/telegram/guards";
import { POST_LOGIN_PATH } from "./paths";
import { createSessionToken, serializeSessionCookie } from "./session";

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

export const LOGIN_NEXT_PREFIXES = ["/dashboard", "/tasks", "/weak-spots", "/billing"] as const;

// The only open redirect surface on this route: a next param survives if it is
// a same-site relative path (single leading slash), has no backslash, dot-dot
// or encoded dot-dot, and sits under an allowed prefix. Everything else,
// including //evil.com, https://evil.com and /\evil, falls back to /dashboard.
export function safeNextPath(raw: string | null | undefined): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.trim() !== raw) {
    return POST_LOGIN_PATH;
  }
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) {
    return POST_LOGIN_PATH;
  }
  let path = raw;
  try {
    path = decodeURIComponent(raw);
  } catch {
    return POST_LOGIN_PATH;
  }
  if (path.includes("\\") || /[\r\n]/.test(path) || path.split("/").includes("..")) {
    return POST_LOGIN_PATH;
  }
  const allowed = LOGIN_NEXT_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
  return allowed ? path : POST_LOGIN_PATH;
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
  allowedIds: number[];
  /** Real impl resolves to lib/clarify/queries.getUserByTelegramId. */
  getUserByTelegramId: (
    telegramUserId: number,
  ) => Promise<{ id: string; telegramChatId: number } | null>;
  /** Real impl is lib/db/queries.upsertUser. */
  upsertUser: (input: UpsertUserInput) => Promise<{ id: string }>;
  /** Real impl is createSessionToken, the same session the magic link issues. */
  createSession: (userId: string) => Promise<string>;
  now: Date;
};

export type TelegramLoginOutcome =
  | { kind: "ok"; userId: string; sessionToken: string }
  | { kind: "denied" }
  | { kind: "invalid" };

export async function completeTelegramLogin(
  deps: TelegramLoginDeps,
  params: TelegramLoginParams,
): Promise<TelegramLoginOutcome> {
  const verified = verifyTelegramLogin(params, deps.botToken, deps.now);
  if (!verified.ok) return { kind: "invalid" };

  // Same invite gate as the bot (lib/telegram/guards.isAllowedUser). The
  // allowlist is keyed on the numeric Telegram user id, so a stranger cannot
  // create an account by logging in from the web.
  if (!isAllowedUser(verified.user.id, deps.allowedIds)) return { kind: "denied" };

  const existing = await deps.getUserByTelegramId(verified.user.id);
  // A private chat id equals the Telegram user id, so a web first account uses
  // it; the bot still cannot message them until they send /start. An existing
  // row keeps the chat id it already has, so web login never rewrites it.
  const input: UpsertUserInput = {
    telegramUserId: verified.user.id,
    telegramChatId: existing ? existing.telegramChatId : verified.user.id,
    firstName: verified.user.firstName,
  };
  const row = await deps.upsertUser(input);
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
    const cookie = serializeSessionCookie(outcome.sessionToken, url.origin);
    return loginRedirect(absolute(safeNextPath(url.searchParams.get("next")), url.origin), cookie);
  }
  const error = outcome.kind === "denied" ? "not_invited" : "failed";
  return loginRedirect(absolute(`/login?error=${error}`, url.origin));
}

// Real deps resolved lazily so importing this module never reads env and never
// touches the database (same pattern as lib/auth/tokens.ts).
export function realTelegramLoginDeps(): TelegramLoginDeps {
  return {
    get botToken() {
      return env.TELEGRAM_BOT_TOKEN;
    },
    get allowedIds() {
      return env.ALLOWED_TELEGRAM_IDS;
    },
    get getUserByTelegramId() {
      return async (telegramUserId: number) => {
        const row = await getUserByTelegramId(telegramUserId);
        return row ? { id: row.id, telegramChatId: row.telegram_chat_id } : null;
      };
    },
    get upsertUser() {
      return upsertUser;
    },
    get createSession() {
      return (userId: string) => createSessionToken(userId);
    },
    now: new Date(),
  };
}
