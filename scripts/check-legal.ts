// Legal page check: fills the tokens from the env, then reports every
// unresolved counsel marker, leftover token and placeholder in the three
// content/legal documents. Exit 1 while anything is unresolved, 0 when the
// pages are publish ready.
//
// Usage: bun --env-file=/opt/settle.env run scripts/check-legal.ts
//
// This script deliberately does NOT use the shared validated env loader: that
// would demand the unrelated Telegram, Stripe and database secrets and crash
// on a machine that only wants to check the legal text. It reads exactly five
// variables from process.env; every other part of the env file can stay empty
// here.
//
// PRIVACY: problem excerpts start at the problem itself, so the filled
// operator name and support email are never printed; only variable names
// appear, inside [[MISSING: VAR]] markers.

import { runLegalCheck } from "../lib/legal/check";
import { loadAllLegalSources } from "../lib/legal/content";
import type { LegalTokenEnv } from "../lib/legal/tokens";
import { TERMS_VERSION } from "../lib/legal/version";

// The raw string env the script reads, injectable so tests never touch
// process.env.
export type LegalScriptRawEnv = Record<string, string | undefined>;

// Blank counts as absent, same rule as the normalize step in lib/env.
function optional(raw: string | undefined): string | undefined {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed.length > 0 ? trimmed : undefined;
}

// Same convention as the STRIPE_MANAGED_PAYMENTS zod schema in lib/env.ts:
// exactly "true" or "false", blank counts as absent and defaults to false,
// anything else fails loudly instead of silently flipping the flag.
function booleanFlag(raw: string | undefined): boolean {
  const value = optional(raw);
  if (value === undefined) return false;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("STRIPE_MANAGED_PAYMENTS must be true or false");
}

// Builds the token env from a raw string map (normally process.env).
export function legalEnvFromRaw(raw: LegalScriptRawEnv): LegalTokenEnv {
  return {
    LEGAL_OPERATOR_NAME: optional(raw.LEGAL_OPERATOR_NAME),
    LEGAL_SUPPORT_EMAIL: optional(raw.LEGAL_SUPPORT_EMAIL),
    LEGAL_SUPABASE_REGION: optional(raw.LEGAL_SUPABASE_REGION),
    LEGAL_VPS_PROVIDER: optional(raw.LEGAL_VPS_PROVIDER),
    STRIPE_MANAGED_PAYMENTS: booleanFlag(raw.STRIPE_MANAGED_PAYMENTS),
  };
}

async function main(): Promise<number> {
  const result = runLegalCheck({
    sources: loadAllLegalSources(),
    env: legalEnvFromRaw(process.env),
    version: TERMS_VERSION,
  });
  // Keep the key order stable: terms, privacy, refund.
  for (const line of result.lines) console.log(line);
  return result.exitCode;
}

if (import.meta.main) {
  process.exit(await main());
}
