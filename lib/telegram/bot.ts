import "server-only";
import { Bot, type BotError } from "grammy";
import { env } from "@/lib/env";
import { createDashboardCommand, type DashboardContextLike } from "@/lib/auth/dashboard-command";
import {
  createDoneCommand,
  createTasksCommand,
  type CommandContextLike,
} from "@/lib/telegram/commands";
import { upsertUser } from "@/lib/db/queries";
import { createPendingActionCallback, type CallbackContextLike } from "@/lib/telegram/callbacks";
import { getAccessPolicy } from "@/lib/telegram/access";
import {
  allowlistMiddleware,
  registerIngestHandlers,
} from "@/lib/telegram/handlers";
import {
  createConsentAcceptHandler,
  consentMiddleware,
  createConsentDeps,
  type ConsentCallbackContextLike,
  type ConsentDeps,
} from "@/lib/telegram/consent";
import { registerPaymentHandlers } from "@/lib/telegram/payments";
import { PRE_CHECKOUT_CLOSED_REPLY, REFUSAL_TEXT, startText } from "@/lib/telegram/replies";

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
  // route's guards, so the access policy has to live on the bot itself. Read
  // at bot creation, not at import, so env is only needed once polling or
  // handling actually starts.
  bot.use(
    allowlistMiddleware(
      getAccessPolicy(),
      (chatId) => bot.api.sendMessage(chatId, REFUSAL_TEXT),
      // A stranger's checkout must still be answered, or Telegram spins for
      // ten seconds and then fails it with a generic error.
      (queryId) =>
        bot.api.answerPreCheckoutQuery(queryId, false, {
          error_message: PRE_CHECKOUT_CLOSED_REPLY,
        }),
    ),
  );
  // Second middleware: nothing about a sender is stored or processed until
  // they have accepted the current Terms and Privacy Policy. Shared with
  // registerHandlers so the accept callback and the gate see the same deps.
  const consentDeps = createConsentDeps();
  bot.use(consentMiddleware(consentDeps));
  registerHandlers(bot, consentDeps);
  bot.catch((error: BotError) => {
    console.error("[telegram] handler error", error.error);
  });
  return bot;
}

// The /start, /help, /dashboard, /tasks and /done handlers below are final;
// registerIngestHandlers adds the text, photo, document and catch-all message
// handlers after them, so a "/tasks" text always reaches its command handler
// first and never the generic text handler. consentDeps wires the tc:ok accept
// callback, which must sit before the pending action callback so a consent tap
// never falls into the pa: resolver.
export function registerHandlers(bot: Bot, consentDeps: ConsentDeps = createConsentDeps()): void {
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

  const tasksCommand = createTasksCommand();
  bot.command("tasks", (ctx) => tasksCommand(ctx as unknown as CommandContextLike));

  const doneCommand = createDoneCommand();
  bot.command("done", (ctx) => doneCommand(ctx as unknown as CommandContextLike));

  // The consent accept tap. Registered BEFORE the pending action callback: a
  // non tc:ok callback is handed to next() here, so pa: taps still reach it,
  // while tc:ok never can.
  const consentAccept = createConsentAcceptHandler(consentDeps);
  bot.on("callback_query:data", (ctx, next) =>
    consentAccept(ctx as unknown as ConsentCallbackContextLike, next),
  );

  // Taps on the Yes/No buttons of a low-confidence clarification. The
  // allowlist middleware above runs first for callback updates too (they carry
  // ctx.from), so a stranger's tap is refused before reaching this.
  const pendingActionCallback = createPendingActionCallback();
  bot.on("callback_query:data", (ctx) =>
    pendingActionCallback(ctx as unknown as CallbackContextLike),
  );

  // /pro, /paysupport, pre_checkout_query and successful_payment. Registered
  // before the ingest handlers so a payment message never reaches the
  // catch-all "message" handler.
  registerPaymentHandlers(bot);

  registerIngestHandlers(bot);
}

export const HELP_TEXT = [
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
  "/tasks - show the five things to handle first",
  "/done <n> - tick one off by its number, like /done 1",
  "/dashboard - get a single use link to open your dashboard",
  "/pro - see Settle Pro and pay with Telegram Stars",
  "/paysupport - help with a payment or a refund",
].join("\n");
