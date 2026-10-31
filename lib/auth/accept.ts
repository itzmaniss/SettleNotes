import "server-only";
import { env } from "@/lib/env";
import { getUserByTelegramId } from "@/lib/clarify/queries";
import { getUserById, upsertUser, type UpsertUserInput } from "@/lib/db/queries";
import type { UserRow } from "@/lib/db/types";
import { hasAcceptedCurrentTerms } from "@/lib/legal/consent";
import { TERMS_VERSION } from "@/lib/legal/version";
import {
  verifyConsentToken,
  type ConsentClaims,
} from "./consent-cookie";
import { POST_LOGIN_PATH, safeNextPath } from "./paths";
import { createSessionToken, verifySessionToken } from "./session";

// The /accept page and its server action, with every dependency injected so
// tests run without env, network or database (same split as telegram-login.ts).
// Identity always comes from the signed consent cookie or the signed session
// cookie re-verified here; the form's hidden fields never carry identity.

export type AcceptDeps = {
  // Signs and verifies both the consent handoff and session tokens.
  secret: string;
  // Cookie flags and nothing else: every redirect is a relative path.
  appBaseUrl: string;
  getUserByTelegramId: (telegramUserId: number) => Promise<UserRow | null>;
  getUserById: (id: string) => Promise<UserRow | null>;
  upsertUser: (input: UpsertUserInput) => Promise<UserRow>;
  createSessionToken: (userId: string) => Promise<string>;
  now: () => Date;
};

export type AcceptVisitorInput = {
  consentToken?: string | null;
  sessionToken?: string | null;
};

export type AcceptVisitor =
  // Verified consent cookie (Telegram web login handoff).
  | { kind: "consent"; claims: ConsentClaims }
  // Signed-in user whose acceptance is missing or stale.
  | { kind: "session"; row: UserRow }
  // Signed-in user who already accepted the current terms.
  | { kind: "accepted" };

/**
 * What the /accept page should do for this visitor. Null means neither cookie
 * verified: the caller redirects to /login. A session pointing at a row that
 * no longer exists counts as anonymous, failing closed.
 */
export async function resolveAcceptVisitor(
  deps: AcceptDeps,
  input: AcceptVisitorInput,
): Promise<AcceptVisitor | null> {
  const now = deps.now();
  const claims = await verifyConsentToken(input.consentToken ?? undefined, deps.secret, now);
  if (claims != null) return { kind: "consent", claims };

  const session = await verifySessionToken(input.sessionToken ?? undefined, {
    secret: deps.secret,
    now: () => now,
  });
  if (session == null) return null;
  const row = await deps.getUserById(session.userId);
  if (row == null) return null;
  return hasAcceptedCurrentTerms(row) ? { kind: "accepted" } : { kind: "session", row };
}

export type AcceptActionInput = AcceptVisitorInput & {
  // Navigation hint from the form; constrained by safeNextPath, never trusted
  // as identity.
  next?: string | null;
};

export type AcceptOutcome =
  | {
      kind: "ok";
      // Where to send the visitor next (always a safe relative path).
      location: string;
      // Session token to set as a cookie, or null when the visitor already has
      // a live session that should be kept as is.
      sessionToken: string | null;
      // True when the 10 minute consent cookie must be cleared.
      clearConsentCookie: boolean;
    }
  // Nothing valid was presented; the caller redirects to /login.
  | { kind: "anonymous" };

/**
 * Records the acceptance for whoever the cookies verify, then says where the
 * action should redirect and which cookies to write. Re-verifies everything
 * itself, so a crafted form cannot accept on someone else's behalf.
 */
export async function performAccept(
  deps: AcceptDeps,
  input: AcceptActionInput,
): Promise<AcceptOutcome> {
  const visitor = await resolveAcceptVisitor(deps, input);
  if (visitor === null) return { kind: "anonymous" };
  const acceptedAt = deps.now();

  if (visitor.kind === "consent") {
    const existing = await deps.getUserByTelegramId(visitor.claims.tid);
    // Chat id equals the Telegram id for a NEW row only; an existing row keeps
    // the chat id it already has, so the web never rewrites it.
    const row = await deps.upsertUser({
      telegramUserId: visitor.claims.tid,
      telegramChatId: existing ? existing.telegram_chat_id : visitor.claims.tid,
      firstName: visitor.claims.fn ?? existing?.first_name ?? null,
      termsAcceptedAt: acceptedAt,
      termsVersion: TERMS_VERSION,
    });
    const sessionToken = await deps.createSessionToken(row.id);
    return {
      kind: "ok",
      location: safeNextPath(input.next),
      sessionToken,
      clearConsentCookie: true,
    };
  }

  if (visitor.kind === "accepted") {
    // Nothing to accept; back to the dashboard.
    return { kind: "ok", location: POST_LOGIN_PATH, sessionToken: null, clearConsentCookie: false };
  }

  // Session case: the row exists, so the upsert writes the terms columns only.
  await deps.upsertUser({
    telegramUserId: visitor.row.telegram_user_id,
    telegramChatId: visitor.row.telegram_chat_id,
    firstName: visitor.row.first_name,
    termsAcceptedAt: acceptedAt,
    termsVersion: TERMS_VERSION,
  });
  return { kind: "ok", location: safeNextPath(input.next), sessionToken: null, clearConsentCookie: false };
}

// Real deps resolved lazily so importing this module never reads env and never
// touches the database (same pattern as lib/auth/tokens.ts).
export function realAcceptDeps(): AcceptDeps {
  return {
    get secret() {
      return env.SESSION_SECRET;
    },
    get appBaseUrl() {
      return env.APP_BASE_URL;
    },
    get getUserByTelegramId() {
      return getUserByTelegramId;
    },
    get getUserById() {
      return getUserById;
    },
    get upsertUser() {
      return upsertUser;
    },
    get createSessionToken() {
      return (userId: string) => createSessionToken(userId);
    },
    now: () => new Date(),
  };
}
