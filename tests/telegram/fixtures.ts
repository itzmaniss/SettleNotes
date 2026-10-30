import type { Update } from "grammy/types";
import type { WebhookDeps } from "../../lib/telegram/guards";

export const ALLOWED_ID = 101;
export const STRANGER_ID = 999;
export const SECRET = "secret-token";

export function textUpdate(
  updateId: number,
  fromId: number = ALLOWED_ID,
  chatId: number = ALLOWED_ID,
): Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      text: "hello settle",
      date: 1_700_000_000,
      chat: { id: chatId, type: "private", first_name: "Tim" },
      from: { id: fromId, is_bot: false, first_name: "Tim" },
    },
  } as unknown as Update;
}

export function callbackUpdate(updateId: number, fromId: number): Update {
  return {
    update_id: updateId,
    callback_query: {
      id: `cbq-${updateId}`,
      from: { id: fromId, is_bot: false, first_name: "Tim" },
      chat_instance: "ci",
      data: "done:T1",
      message: {
        message_id: updateId,
        date: 1_700_000_000,
        chat: { id: fromId, type: "private", first_name: "Tim" },
        from: { id: fromId, is_bot: false, first_name: "Tim" },
        text: "original message",
      },
    },
  } as unknown as Update;
}

/** Channel posts carry no from field, so there is no user to allowlist. */
export function channelPostUpdate(updateId: number): Update {
  return {
    update_id: updateId,
    channel_post: {
      message_id: updateId,
      date: 1_700_000_000,
      chat: { id: -100_123, type: "channel", title: "Lecture announcements" },
      text: "slides posted",
    },
  } as unknown as Update;
}

export type SpyDeps = {
  deps: WebhookDeps;
  scheduled: Array<() => Promise<unknown>>;
  seen: number[];
  handled: Update[];
  refusals: number[];
};

export function makeDeps(
  overrides: Partial<WebhookDeps> = {},
  seenIds: Set<number> = new Set(),
): SpyDeps {
  const scheduled: Array<() => Promise<unknown>> = [];
  const seen: number[] = [];
  const handled: Update[] = [];
  const refusals: number[] = [];
  const deps: WebhookDeps = {
    webhookSecret: SECRET,
    allowedIds: [ALLOWED_ID],
    markUpdateSeen: async (updateId) => {
      seen.push(updateId);
      const first = !seenIds.has(updateId);
      seenIds.add(updateId);
      return first;
    },
    schedule: (fn) => {
      scheduled.push(fn);
    },
    handleUpdate: async (update) => {
      handled.push(update);
    },
    sendRefusal: async (chatId) => {
      refusals.push(chatId);
    },
  };
  Object.assign(deps, overrides);
  return { deps, scheduled, seen, handled, refusals };
}

export function webhookRequest(
  body: unknown,
  secret: string | null = SECRET,
): Request {
  const headers: Record<string, string> = {};
  if (secret !== null) headers["x-telegram-bot-api-secret-token"] = secret;
  return new Request("https://example.com/api/telegram", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
