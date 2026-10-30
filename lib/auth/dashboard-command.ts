import "server-only";
import { InlineKeyboard } from "grammy";
import type { Chat, User } from "grammy/types";
import { dashboardLinkFailureReply, dashboardLinkReply } from "@/lib/auth/copy";
import { issueLoginLink } from "@/lib/auth/tokens";
import { upsertUser } from "@/lib/db/queries";
import type { UpsertUserInput } from "@/lib/db/queries";
import type { UserRow } from "@/lib/db/types";

// Minimal structural view of a grammY context for the /dashboard command, so
// tests can pass tiny fakes like handlers.ts BotContextLike.
export type DashboardReplyOptions = {
  reply_markup?: unknown;
  link_preview_options?: unknown;
};

export type DashboardContextLike = {
  from?: User;
  chat?: Chat;
  reply: (text: string, other?: DashboardReplyOptions) => Promise<unknown>;
};

export type DashboardCommandDeps = {
  upsertUser: (i: UpsertUserInput) => Promise<UserRow>;
  issueLoginLink: (userId: string) => Promise<string>;
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

// Same rule as replies.ts dashboardKeyboard: Telegram rejects http and
// loopback button URLs. The button must carry THIS single use link, never the
// generic dashboard URL, or tapping it would burn a different token.
export function dashboardLinkKeyboard(link: string): InlineKeyboard | undefined {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return undefined;
  }
  const hostname = url.hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (url.protocol !== "https:" || LOOPBACK_HOSTS.has(hostname)) return undefined;
  return new InlineKeyboard().url("Open dashboard", link);
}

export function createDashboardCommand(deps: Partial<DashboardCommandDeps> = {}) {
  const upsert = deps.upsertUser ?? upsertUser;
  const issue = deps.issueLoginLink ?? issueLoginLink;
  return async (ctx: DashboardContextLike): Promise<void> => {
    const from = ctx.from;
    if (!from) return;
    try {
      const user = await upsert({
        telegramUserId: from.id,
        telegramChatId: ctx.chat?.id ?? from.id,
        firstName: from.first_name ?? null,
      });
      const link = await issue(user.id);
      const keyboard = dashboardLinkKeyboard(link);
      await ctx.reply(dashboardLinkReply(link), {
        // The link preview fetcher would otherwise open the single use URL
        // and consume the token before the student taps it.
        link_preview_options: { is_disabled: true },
        ...(keyboard ? { reply_markup: keyboard } : {}),
      });
    } catch (error) {
      // Never leak secrets; just apologise and ask for a retry.
      console.error(
        "[telegram] dashboard link failed:",
        error instanceof Error ? error.message : String(error),
      );
      try {
        await ctx.reply(dashboardLinkFailureReply(), {
          link_preview_options: { is_disabled: true },
        });
      } catch (replyError) {
        console.error(
          "[telegram] dashboard failure reply failed:",
          replyError instanceof Error ? replyError.message : String(replyError),
        );
      }
    }
  };
}
