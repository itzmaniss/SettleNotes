import "server-only";
import { Bot, type BotError } from "grammy";
import { env } from "@/lib/env";
import { createDashboardCommand, type DashboardContextLike } from "@/lib/auth/dashboard-command";
import { upsertUser } from "@/lib/db/queries";
import { allowlistMiddleware, registerIngestHandlers } from "@/lib/telegram/handlers";
import { REFUSAL_TEXT } from "@/lib/telegram/replies";

// The token is only read when getBot() first runs, never at import time, so
// `next build` and the test runner never need env vars just to import this.
let botInstance: Bot | undefined;

export function getBot(): Bot {
  botInstance ??= createBot();
  return botInstance;
}

let readyPromise: Promise<Bot> | undefined;

/**
 * Runs bot.init() exactly once (memoised). The memo is cleared on failure so
 * the next call retries instead of caching a broken state.
 */
export function ensureBotReady(): Promise<Bot> {
  const bot = getBot();
  readyPromise ??= bot
    .init()
    .then(() => bot)
    .catch((error) => {
      readyPromise = undefined;
      throw error;
    });
  return readyPromise;
}

function createBot(): Bot {
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);
  // Very first middleware: the poll script runs this bot without the webhook
  // route's guards, so the allowlist has to live on the bot itself.
  bot.use(
    allowlistMiddleware(env.ALLOWED_TELEGRAM_IDS, (chatId) =>
      bot.api.sendMessage(chatId, REFUSAL_TEXT),
    ),
  );
  registerHandlers(bot);
  bot.catch((error: BotError) => {
    console.error("[telegram] handler error", error.error);
  });
  return bot;
}

// The /start, /help and /dashboard handlers below are final;
// registerIngestHandlers adds the text, photo, document and catch-all message
// handlers after them.
export function registerHandlers(bot: Bot): void {
  bot.command("start", async (ctx) => {
    const from = ctx.from;
    if (!from) return;
    await upsertUser({
      telegramUserId: from.id,
      telegramChatId: ctx.chat?.id ?? from.id,
      firstName: from.first_name ?? null,
    });
    await ctx.reply(startText(from.first_name ?? null, env.APP_BASE_URL));
  });

  bot.command("help", (ctx) => ctx.reply(HELP_TEXT));

  const dashboardCommand = createDashboardCommand();
  bot.command("dashboard", (ctx) =>
    dashboardCommand(ctx as unknown as DashboardContextLike),
  );

  registerIngestHandlers(bot);
}

function startText(firstName: string | null, dashboardUrl: string): string {
  const greeting = firstName ? `Hi ${firstName}!` : "Hi!";
  return [
    `${greeting} I am Settle, your study catch-up buddy.`,
    "",
    "Forward me class group chat messages, send assignment PDFs, lecture slides, photos of your math working, or just talk to me. I turn all of it into one tidy task list, keep an eye on deadlines, and build practice from your weak spots.",
    "",
    `Open your dashboard anytime: ${dashboardUrl}`,
    "",
    "Send /help to see exactly what I understand.",
  ].join("\n");
}

const HELP_TEXT = [
  "Here is what you can send me:",
  "",
  "- Screenshots of class or group chats. I will pull out the deadlines and add them to your task list.",
  "- Assignment briefs and lecture slides as PDFs or photos. I will summarise what is due and build a checklist or flashcards.",
  "- Photos of your math working. I will find the first step that went wrong and explain the fix.",
  "- Voice notes. I will transcribe them and sort out any tasks hiding inside.",
  "",
  "Commands:",
  "/help - show this list",
  "/start - reintroduce myself",
  "/dashboard - get a single use link to open your dashboard",
].join("\n");
