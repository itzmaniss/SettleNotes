// Legal page check: fills the tokens from the real env, then reports every
// unresolved counsel marker, leftover token and placeholder in the three
// content/legal documents. Exit 1 while anything is unresolved, 0 when the
// pages are publish ready.
//
// Usage: bun --env-file=/opt/settle.env run scripts/check-legal.ts
//
// PRIVACY: problem excerpts start at the problem itself, so the filled
// operator name and support email are never printed; only variable names
// appear, inside [[MISSING: VAR]] markers.

import { getEnv } from "../lib/env";
import { runLegalCheck } from "../lib/legal/check";
import { LEGAL_VERSION, loadAllLegalSources } from "../lib/legal/content";
import type { LegalTokenEnv } from "../lib/legal/tokens";

function legalEnv(env: ReturnType<typeof getEnv>): LegalTokenEnv {
  return {
    LEGAL_OPERATOR_NAME: env.LEGAL_OPERATOR_NAME,
    LEGAL_SUPPORT_EMAIL: env.LEGAL_SUPPORT_EMAIL,
    LEGAL_SUPABASE_REGION: env.LEGAL_SUPABASE_REGION,
    LEGAL_VPS_PROVIDER: env.LEGAL_VPS_PROVIDER,
    STRIPE_MANAGED_PAYMENTS: env.STRIPE_MANAGED_PAYMENTS,
  };
}

async function main(): Promise<number> {
  const env = getEnv(); // fail fast with the normal env validation message
  const sources = loadAllLegalSources();
  const result = runLegalCheck({
    sources,
    env: legalEnv(env),
    version: LEGAL_VERSION,
  });
  // Keep the key order stable: terms, privacy, refund.
  for (const line of result.lines) console.log(line);
  return result.exitCode;
}

if (import.meta.main) {
  process.exit(await main());
}
