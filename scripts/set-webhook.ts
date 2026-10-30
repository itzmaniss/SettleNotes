// One-shot admin script: point the Telegram webhook at this deployment.
// Usage: bun run scripts/set-webhook.ts
import { env } from "../lib/env";
import { ensureBotReady } from "../lib/telegram/bot";
import { resolveWebhookUrl } from "../lib/telegram/guards";

let url: string;
try {
  url = resolveWebhookUrl(env.APP_BASE_URL);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const bot = await ensureBotReady();
await bot.api.setWebhook(url, {
  secret_token: env.TELEGRAM_WEBHOOK_SECRET,
  allowed_updates: ["message", "callback_query"] as const,
});

// Never print the token or the secret, the URL is the only thing worth showing.
console.log(`Webhook set to ${url}`);
