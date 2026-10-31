// Operator tool: list accounts with no activity for N days (default 365) and
// no live subscription, so the operator can review them one by one.
// Usage: bun run scripts/stale-accounts.ts [--days 365]
//
// SAFETY: this script runs SELECT queries only. No row is ever written,
// changed or removed, so it is safe against the production database. The test
// in tests/privacy/stale.test.ts scans this file's source and
// lib/privacy/stale.ts to pin that.
//
// PRIVACY: output shows short ids, Telegram ids (the operator needs the
// Telegram id to run delete-user; this script is the one place it is printed,
// to the operator's own terminal) and row counts. Names and content are never
// selected and never printed.
// Not imported by app code. Runs under bun only.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "../lib/db/client";
import { getEnv } from "../lib/env";
import { findStaleAccounts, formatStaleSweep, parseStaleArgs } from "../lib/privacy/stale";

export type StaleSweepDeps = {
  client: SupabaseClient;
  log: (line: string) => void;
  error: (line: string) => void;
};

// The whole flow with injected deps so tests run on fakes. Returns the
// process exit code.
export async function runStaleSweep(
  deps: StaleSweepDeps,
  args: { days: number },
): Promise<number> {
  const result = await findStaleAccounts(deps.client, { days: args.days, now: new Date() });
  for (const line of formatStaleSweep(result)) deps.log(line);
  return 0;
}

async function main(): Promise<number> {
  const parsed = parseStaleArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.usage);
    return 1;
  }
  getEnv(); // fail fast with the normal env validation message
  const client = getSupabase();
  return runStaleSweep({ client, log: console.log, error: console.error }, parsed);
}

if (import.meta.main) {
  process.exit(await main());
}
