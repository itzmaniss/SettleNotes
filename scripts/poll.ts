// Local development entry: long polling so no webhook or tunnel is needed.
// Usage: bun run scripts/poll.ts
import { ensureBotReady } from "../lib/telegram/bot";

const bot = await ensureBotReady();

// Explicit up front so a previously registered webhook stops stealing updates;
// bot.start() performs its own deleteWebhook as part of polling setup anyway.
await bot.api.deleteWebhook();

console.log("Settle bot is long polling. Press Ctrl+C to stop.");

let stopping = false;
function stop(signal: string): void {
  if (stopping) return;
  stopping = true;
  console.log(`Received ${signal}, stopping bot.`);
  void bot.stop();
}

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

await bot.start();
