import { after } from "next/server";
import { env } from "@/lib/env";
import { markUpdateSeen } from "@/lib/db/queries";
import { ensureBotReady } from "@/lib/telegram/bot";
import { handleWebhook } from "@/lib/telegram/guards";
import { PRE_CHECKOUT_CLOSED_REPLY } from "@/lib/telegram/replies";

export const runtime = "nodejs";
export const maxDuration = 300;

const REFUSAL_TEXT =
  "Hi! Settle is in private testing right now, so I can't help you yet. Come back soon.";

export async function POST(req: Request): Promise<Response> {
  return handleWebhook(req, {
    webhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
    allowedIds: env.ALLOWED_TELEGRAM_IDS,
    markUpdateSeen,
    schedule: (fn) => {
      after(fn);
    },
    handleUpdate: async (update) => {
      const bot = await ensureBotReady();
      await bot.handleUpdate(update);
    },
    sendRefusal: async (chatId) => {
      const bot = await ensureBotReady();
      await bot.api.sendMessage(chatId, REFUSAL_TEXT);
    },
    answerPreCheckoutRefusal: async (queryId) => {
      const bot = await ensureBotReady();
      await bot.api.answerPreCheckoutQuery(queryId, false, {
        error_message: PRE_CHECKOUT_CLOSED_REPLY,
      });
    },
  });
}
