import "server-only";
import { logAiCall, todaysAiSpend } from "@/lib/db/queries";
import { env } from "@/lib/env";
import { createMetaClient, createOpenAIClient, type MetaClient } from "@/lib/meta/client";

let client: MetaClient | undefined;

// Singleton resolved on first use so importing this module never touches env
// or the DB, keeping `next build` and the test runner free of live config.
export function getMetaClient(): MetaClient {
  client ??= createMetaClient({
    openai: createOpenAIClient(env.MODEL_API_KEY, env.META_API_BASE_URL),
    model: env.META_MODEL,
    dailyBudgetUsd: env.META_DAILY_BUDGET_USD,
    logAiCall,
    getTodaySpend: () => todaysAiSpend(),
  });
  return client;
}
