import "server-only";
import { timingSafeEqual } from "node:crypto";
import type { Update } from "grammy/types";

/**
 * All webhook logic lives here so the route file stays a thin wrapper:
 * Next route files may only export HTTP handlers and segment config.
 * Everything is dependency-injected so tests run with no network and no DB.
 */
export type WebhookDeps = {
  webhookSecret: string;
  allowedIds: number[];
  markUpdateSeen: (updateId: number) => Promise<boolean>;
  /** Real impl is `after` from "next/server"; tests collect and run manually. */
  schedule: (fn: () => Promise<unknown>) => void;
  handleUpdate: (update: Update) => Promise<void>;
  sendRefusal: (chatId: number) => Promise<void>;
  /**
   * Stars checkouts: a pre_checkout_query has no chat to refuse in and must
   * be answered within 10 seconds, so a payer outside the allowlist gets
   * answered false inline instead of a refusal message.
   */
  answerPreCheckoutRefusal?: (queryId: string) => Promise<void>;
};

const SECRET_HEADER = "x-telegram-bot-api-secret-token";

/** Length-safe constant-time compare; false (never throws) for null or length mismatch. */
export function verifySecret(header: string | null, expected: string): boolean {
  if (header === null || header.length === 0 || expected.length === 0) {
    return false;
  }
  const given = Buffer.from(header, "utf8");
  const want = Buffer.from(expected, "utf8");
  if (given.length !== want.length) return false;
  return timingSafeEqual(given, want);
}

export function isAllowedUser(
  telegramUserId: number | undefined,
  allowed: number[],
): boolean {
  if (telegramUserId === undefined) return false;
  return allowed.includes(telegramUserId);
}

/** Sender id for the update types we accept; undefined for channel posts etc. */
export function senderIdOf(update: Update): number | undefined {
  return (
    update.message?.from?.id ?? update.callback_query?.from.id ?? update.pre_checkout_query?.from.id
  );
}

/** Where to reply: the message chat, else the callback's message chat, else the sender. */
export function chatIdOf(update: Update): number | undefined {
  if (update.message) return update.message.chat.id;
  const query = update.callback_query;
  if (query) return query.message?.chat.id ?? query.from.id;
  return undefined;
}

/**
 * Order per ARCHITECTURE section 2:
 * 1. secret check before the body is even read
 * 2. parse JSON (400 on invalid)
 * 3. dedupe via markUpdateSeen (duplicate -> 200, no handling)
 * 4. allowlist (stranger -> scheduled refusal reply, 200)
 * 5. schedule the real handler and ack immediately
 */
export async function handleWebhook(
  req: Request,
  deps: WebhookDeps,
): Promise<Response> {
  if (!verifySecret(req.headers.get(SECRET_HEADER), deps.webhookSecret)) {
    // Generic on purpose: no detail about why it failed.
    return new Response("Unauthorized", { status: 401 });
  }

  let update: Update;
  try {
    update = (await req.json()) as Update;
  } catch {
    return new Response("Bad Request", { status: 400 });
  }
  if (
    typeof update !== "object" ||
    update === null ||
    typeof update.update_id !== "number"
  ) {
    return new Response("Bad Request", { status: 400 });
  }

  const firstTimeSeen = await deps.markUpdateSeen(update.update_id);
  if (!firstTimeSeen) {
    // Telegram retry of an update we already handled.
    return new Response("OK", { status: 200 });
  }

  const senderId = senderIdOf(update);
  if (senderId === undefined) {
    // No user to allowlist (e.g. channel post): ack and ignore.
    return new Response("OK", { status: 200 });
  }

  if (!isAllowedUser(senderId, deps.allowedIds)) {
    if (update.pre_checkout_query !== undefined) {
      // Answered inline and before the 200 so the payer's checkout never
      // hangs out the full 10 seconds.
      if (deps.answerPreCheckoutRefusal !== undefined) {
        await deps.answerPreCheckoutRefusal(update.pre_checkout_query.id);
      }
      return new Response("OK", { status: 200 });
    }
    const chatId = chatIdOf(update);
    if (chatId !== undefined) {
      deps.schedule(runQuietly("refusal", () => deps.sendRefusal(chatId)));
    }
    return new Response("OK", { status: 200 });
  }

  deps.schedule(runQuietly("handleUpdate", () => deps.handleUpdate(update)));
  return new Response("OK", { status: 200 });
}

// Anything scheduled inside after() must swallow its own errors: rethrowing
// there can only log unhandled rejections, the caller is long gone.
function runQuietly(name: string, fn: () => Promise<unknown>) {
  return async () => {
    try {
      await fn();
    } catch (error) {
      console.error(`[telegram] scheduled ${name} failed`, error);
    }
  };
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/** Validates APP_BASE_URL and returns the exact webhook URL to register. Throws on refusal. */
export function resolveWebhookUrl(appBaseUrl: string): string {
  let url: URL;
  try {
    url = new URL(appBaseUrl);
  } catch {
    throw new Error(`APP_BASE_URL is not a valid URL: ${appBaseUrl}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(
      `APP_BASE_URL must use https because Telegram only calls https webhooks (got ${url.protocol}). Deploy first or run scripts/poll.ts locally instead.`,
    );
  }
  // IPv6 hosts come out of URL.hostname wrapped in brackets.
  const hostname = url.hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (LOOPBACK_HOSTS.has(hostname)) {
    throw new Error(
      `APP_BASE_URL points at ${hostname}, which Telegram cannot reach. Deploy the app and set APP_BASE_URL to its public https URL.`,
    );
  }
  return `${url.href.replace(/\/+$/, "")}/api/telegram`;
}
