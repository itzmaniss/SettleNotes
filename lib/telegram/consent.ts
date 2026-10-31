import "server-only";
import { InlineKeyboard, type Context, type NextFunction } from "grammy";
import type { Chat, Message, User } from "grammy/types";
import { env } from "@/lib/env";
import { getUserByTelegramId } from "@/lib/clarify/queries";
import { upsertUser, type UpsertUserInput } from "@/lib/db/queries";
import type { UserRow } from "@/lib/db/types";
import { consentStatus, type ConsentStatus } from "@/lib/legal/consent";
import {
  CONSENT_AGAIN_NOTE,
  CONSENT_BUTTONS,
  CONSENT_INTRO,
  CONSENT_PAY_FIRST,
  CONSENT_PLAIN_LINES,
  CONSENT_RESEND_NOTE,
  CONSENT_THANKS,
} from "@/lib/legal/consent-copy";
import { LEGAL_PATHS } from "@/lib/legal/paths";
import { TERMS_VERSION } from "@/lib/legal/version";
import {
  clearedKeyboard,
  commandFailedReply,
  dashboardKeyboard,
  startText,
} from "@/lib/telegram/replies";

// The consent gate: the second middleware on the bot, right after the
// allowlist. Nothing about a sender is stored, uploaded, transcribed or sent
// to the AI until they have accepted the current Terms and Privacy Policy by
// tapping the agree button. The acceptance row is created by exactly one place
// per surface: this module's accept callback for Telegram, lib/auth/accept.ts
// for the web.

/** Callback data of the agree button. Short: Telegram caps callback data. */
export const CONSENT_CALLBACK_DATA = "tc:ok";

// Minimal structural views of a grammY context, so tests pass tiny fakes like
// handlers.ts BotContextLike instead of building a real Bot.
export type ConsentReplyContextLike = {
  reply: (text: string, other?: { reply_markup?: unknown }) => Promise<unknown>;
};

export type ConsentContextLike = ConsentReplyContextLike & {
  from?: User;
  chat?: Chat;
  message?: Message;
  callbackQuery?: { data?: string };
  preCheckoutQuery?: { id: string };
  answerPreCheckoutQuery: (
    ok: boolean,
    other?: { error_message?: string },
  ) => Promise<unknown>;
};

export type ConsentCallbackContextLike = ConsentReplyContextLike & {
  from?: User;
  chat?: Chat;
  callbackQuery?: { data?: string };
  answerCallbackQuery: (other?: { text?: string }) => Promise<unknown>;
  editMessageText: (text: string, other?: { reply_markup?: unknown }) => Promise<unknown>;
};

export type ConsentPromptSender = (
  ctx: ConsentReplyContextLike,
  text: string,
  keyboard: InlineKeyboard | undefined,
) => Promise<unknown>;

export type ConsentDeps = {
  getUserByTelegramId: (telegramUserId: number) => Promise<UserRow | null>;
  upsertUser: (input: UpsertUserInput) => Promise<UserRow>;
  now: () => Date;
  appBaseUrl: string;
  sendConsentPrompt: ConsentPromptSender;
};

// ---- pure prompt builders ---------------------------------------------------

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

// Same rule as replies.dashboardKeyboard: Telegram rejects non-https button
// URLs (and loopback hosts), so there the addresses go into the text instead.
function buttonUrlsUsable(appBaseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(appBaseUrl);
  } catch {
    return false;
  }
  const hostname = url.hostname.replace(/^\[/, "").replace(/\]$/, "");
  return url.protocol === "https:" && !LOOPBACK_HOSTS.has(hostname);
}

// Row 1: Terms and Privacy Policy as URL buttons. Row 2: the agree button.
// Undefined keyboard means the caller must send the prompt without buttons and
// the text already carries the plain addresses (buildConsentPrompt does that).
export function consentKeyboard(appBaseUrl: string): InlineKeyboard | undefined {
  if (!buttonUrlsUsable(appBaseUrl)) return undefined;
  const base = appBaseUrl.replace(/\/+$/, "");
  return new InlineKeyboard()
    .url(CONSENT_BUTTONS.terms, `${base}${LEGAL_PATHS.terms}`)
    .url(CONSENT_BUTTONS.privacy, `${base}${LEGAL_PATHS.privacy}`)
    .row()
    .text(CONSENT_BUTTONS.agree, CONSENT_CALLBACK_DATA);
}

// One message, assembled in a fixed order: the changed-terms note first, then
// the dropped-message note, then the intro. Without usable button URLs the
// two legal addresses become plain lines under the intro.
export function buildConsentPrompt(
  status: Exclude<ConsentStatus, "ok">,
  blockedKind: "start" | "other",
  appBaseUrl: string,
): { text: string; keyboard: InlineKeyboard | undefined } {
  const lines: string[] = [];
  if (status === "stale") lines.push(CONSENT_AGAIN_NOTE);
  if (blockedKind === "other") lines.push(CONSENT_RESEND_NOTE);
  lines.push(CONSENT_INTRO);
  const keyboard = consentKeyboard(appBaseUrl);
  if (keyboard === undefined) lines.push(CONSENT_PLAIN_LINES(appBaseUrl));
  return { text: lines.join("\n\n"), keyboard };
}

// ---- middleware -------------------------------------------------------------

function isCommand(text: string | undefined, name: string): boolean {
  if (typeof text !== "string" || !text.startsWith("/")) return false;
  return text.slice(1).split(/[\s@]/)[0] === name;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// A failed reply must never throw out of the middleware chain.
async function replyQuietly(
  ctx: ConsentReplyContextLike,
  text: string,
  markup?: unknown,
): Promise<void> {
  try {
    await ctx.reply(text, markup === undefined ? undefined : { reply_markup: markup });
  } catch (error) {
    console.error("[telegram] reply failed:", errorMessage(error));
  }
}

async function answerPreCheckoutQuietly(
  ctx: ConsentContextLike,
  ok: boolean,
  message?: string,
): Promise<void> {
  try {
    await ctx.answerPreCheckoutQuery(ok, ok ? undefined : { error_message: message });
  } catch (error) {
    console.error("[telegram] answering the pre-checkout query failed:", errorMessage(error));
  }
}

/**
 * Registered immediately after the allowlist middleware and before every other
 * handler. Per update from an allowed sender:
 * - callback data tc:ok passes through to the accept handler;
 * - a successful_payment always passes through (the money already moved; the
 *   booking and the thank-you must never be dropped);
 * - /help passes through (static text, stores nothing, so no lookup at all);
 * - a pre_checkout_query from anyone not on the current terms is answered
 *   false with a friendly line, never a silent drop (Telegram waits 10s);
 * - everything else from a sender whose consent status is not "ok" gets ONE
 *   consent prompt in a private chat and is dropped: no user row, no upload
 *   row, no AI call, nothing stored from the message;
 * - in groups and channels an unaccepted sender is ignored quietly, as before;
 * - a lookup error fails closed with the friendly command reply: we cannot
 *   verify consent, so nothing is processed.
 */
export function consentMiddleware(deps: ConsentDeps) {
  return async (ctx: Context, next: NextFunction): Promise<void> => {
    const c = ctx as unknown as ConsentContextLike;
    const from = c.from;
    // No sender (channel posts and the like): nothing to gate, ignored.
    if (from === undefined) return;
    if (c.callbackQuery?.data === CONSENT_CALLBACK_DATA) return next();
    if (c.message?.successful_payment !== undefined) return next();
    if (isCommand(c.message?.text, "help")) return next();

    let user: UserRow | null;
    try {
      user = await deps.getUserByTelegramId(from.id);
    } catch (error) {
      console.error("[telegram] consent lookup failed, refusing the update:", errorMessage(error));
      if (c.preCheckoutQuery !== undefined) {
        await answerPreCheckoutQuietly(c, false, commandFailedReply());
      } else {
        await replyQuietly(c, commandFailedReply());
      }
      return;
    }
    const status = consentStatus(user);

    if (c.preCheckoutQuery !== undefined) {
      if (status === "ok") return next();
      await answerPreCheckoutQuietly(c, false, CONSENT_PAY_FIRST);
      return;
    }

    if (status === "ok") return next();

    // Groups and channels are ignored as before; the prompt is a private-chat
    // thing, so a stranger in a group never gets a row either.
    if (c.chat?.type !== "private") return;

    const blockedKind = isCommand(c.message?.text, "start") ? "start" : "other";
    const prompt = buildConsentPrompt(status, blockedKind, deps.appBaseUrl);
    await deps.sendConsentPrompt(c, prompt.text, prompt.keyboard);
    // No next(): the update is dropped, nothing was stored.
  };
}

// ---- the accept callback ----------------------------------------------------

/**
 * Handles the tc:ok tap and hands every other callback to next(), so the
 * pending action resolver still sees its pa: taps. Registered BEFORE the
 * pending action callback. The upsert below is the only place a
 * Telegram-first user row is ever created; a double tap is harmless because
 * the upsert is idempotent on telegram_user_id.
 */
export function createConsentAcceptHandler(deps: ConsentDeps) {
  return async (ctx: ConsentCallbackContextLike, next?: () => Promise<void>): Promise<void> => {
    if (ctx.callbackQuery?.data !== CONSENT_CALLBACK_DATA) {
      if (next !== undefined) return next();
      return;
    }
    const from = ctx.from;
    if (from === undefined) return;
    try {
      await ctx.answerCallbackQuery();
    } catch (error) {
      console.error("[telegram] answering the consent tap failed:", errorMessage(error));
    }
    // A private chat id equals the Telegram user id; a tap anywhere else
    // (a stale button in a group) must never write a group id as the DM chat.
    const chatId = ctx.chat?.type === "private" ? ctx.chat.id : from.id;
    try {
      await deps.upsertUser({
        telegramUserId: from.id,
        telegramChatId: chatId,
        firstName: from.first_name ?? null,
        termsAcceptedAt: deps.now(),
        termsVersion: TERMS_VERSION,
      });
    } catch (error) {
      // The tap looked accepted but nothing was saved: say so loudly.
      console.error("[telegram] saving the consent acceptance failed:", errorMessage(error));
      await replyQuietly(ctx, commandFailedReply());
      return;
    }
    // The prompt message becomes the thanks, keyboard removed. A failed edit
    // falls back to a plain reply so the student always sees the thanks.
    try {
      await ctx.editMessageText(CONSENT_THANKS, { reply_markup: clearedKeyboard() });
    } catch {
      await replyQuietly(ctx, CONSENT_THANKS);
    }
    const keyboard = dashboardKeyboard(deps.appBaseUrl);
    await replyQuietly(
      ctx,
      startText(from.first_name ?? null, deps.appBaseUrl),
      keyboard ?? undefined,
    );
  };
}

// Real deps resolved lazily so importing this module (and registering the
// middleware) never touches env or the database.
export function createConsentDeps(): ConsentDeps {
  return {
    get getUserByTelegramId() {
      return getUserByTelegramId;
    },
    get upsertUser() {
      return upsertUser;
    },
    now: () => new Date(),
    get appBaseUrl() {
      return env.APP_BASE_URL;
    },
    sendConsentPrompt: (ctx, text, keyboard) =>
      ctx.reply(text, keyboard === undefined ? undefined : { reply_markup: keyboard }),
  };
}
