import { describe, expect, test } from "bun:test";
import type { Chat, User } from "grammy/types";
import {
  createDashboardCommand,
  dashboardLinkKeyboard,
  type DashboardContextLike,
  type DashboardReplyOptions,
} from "../../lib/auth/dashboard-command";
import type { UpsertUserInput } from "../../lib/db/queries";
import type { UserRow } from "../../lib/db/types";
import { dashboardLinkFailureReply, dashboardLinkReply } from "../../lib/auth/copy";

const user: UserRow = {
  id: "user-1",
  telegram_user_id: 101,
  telegram_chat_id: 101,
  first_name: "Tim",
  timezone: "Asia/Singapore",
  created_at: "2026-10-01T01:00:00.000Z",
};

const HTTPS_LINK = "https://settle.example.com/auth/raw-token-value";
const LOCAL_LINK = "http://localhost:3000/auth/raw-token-value";

type Reply = { text: string; other?: DashboardReplyOptions };

function makeCtx(from?: User): { ctx: DashboardContextLike; replies: Reply[] } {
  const replies: Reply[] = [];
  return {
    ctx: {
      from,
      chat: { id: 101, type: "private" } as Chat,
      reply: async (text, other) => {
        replies.push({ text, other });
        return {};
      },
    },
    replies,
  };
}

function makeDeps(link: string, fail = false) {
  const upserts: UpsertUserInput[] = [];
  const linkCalls: string[] = [];
  return {
    upserts,
    linkCalls,
    deps: {
      upsertUser: async (i: UpsertUserInput) => {
        upserts.push(i);
        return user;
      },
      issueLoginLink: async (userId: string) => {
        if (fail) throw new Error("db is down");
        linkCalls.push(userId);
        return link;
      },
    },
  };
}

function markupOf(reply: Reply | undefined) {
  return reply?.other?.reply_markup as
    | { inline_keyboard: Array<Array<{ text: string; url: string }>> }
    | undefined;
}

describe("dashboard command", () => {
  test("upserts the user, issues a link for that user and replies with it", async () => {
    const { ctx, replies } = makeCtx({ id: 101, is_bot: false, first_name: "Tim" } as User);
    const { deps, upserts, linkCalls } = makeDeps(HTTPS_LINK);
    const handler = createDashboardCommand(deps);

    await handler(ctx);

    expect(upserts).toEqual([
      { telegramUserId: 101, telegramChatId: 101, firstName: "Tim" },
    ]);
    expect(linkCalls).toEqual(["user-1"]);
    expect(replies).toHaveLength(1);
    expect(replies[0].text).toBe(dashboardLinkReply(HTTPS_LINK));
    expect(replies[0].text).toContain(HTTPS_LINK);
    // Preview disabled: Telegram's fetcher must never open the single use URL.
    expect(replies[0].other?.link_preview_options).toEqual({ is_disabled: true });
  });

  test("an https link gets an inline Open dashboard button carrying the same link", async () => {
    const { ctx, replies } = makeCtx({ id: 101, is_bot: false, first_name: "Tim" } as User);
    const { deps } = makeDeps(HTTPS_LINK);

    await createDashboardCommand(deps)(ctx);

    const markup = markupOf(replies[0]);
    expect(markup?.inline_keyboard[0][0]).toEqual({ text: "Open dashboard", url: HTTPS_LINK });
  });

  test("a localhost link gets no button because Telegram would reject it", async () => {
    const { ctx, replies } = makeCtx({ id: 101, is_bot: false, first_name: "Tim" } as User);
    const { deps } = makeDeps(LOCAL_LINK);

    await createDashboardCommand(deps)(ctx);

    expect(replies[0].text).toContain(LOCAL_LINK);
    expect(markupOf(replies[0])).toBeUndefined();
  });

  test("a failure replies with the retry copy and never throws", async () => {
    const { ctx, replies } = makeCtx({ id: 101, is_bot: false, first_name: "Tim" } as User);
    const { deps } = makeDeps(HTTPS_LINK, true);

    await expect(createDashboardCommand(deps)(ctx)).resolves.toBeUndefined();

    expect(replies).toHaveLength(1);
    expect(replies[0].text).toBe(dashboardLinkFailureReply());
  });

  test("an update without a sender is ignored", async () => {
    const { ctx, replies } = makeCtx();
    const { deps, upserts, linkCalls } = makeDeps(HTTPS_LINK);

    await createDashboardCommand(deps)(ctx);

    expect(replies).toHaveLength(0);
    expect(upserts).toHaveLength(0);
    expect(linkCalls).toHaveLength(0);
  });
});

describe("dashboardLinkKeyboard", () => {
  test("https non loopback gets a button, everything else does not", () => {
    expect(dashboardLinkKeyboard(HTTPS_LINK)).toBeDefined();
    expect(dashboardLinkKeyboard(LOCAL_LINK)).toBeUndefined();
    expect(dashboardLinkKeyboard("http://settle.example.com/auth/abc")).toBeUndefined();
    expect(dashboardLinkKeyboard("https://127.0.0.1/auth/abc")).toBeUndefined();
    expect(dashboardLinkKeyboard("not a url")).toBeUndefined();
  });
});
