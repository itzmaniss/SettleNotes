// Loads the legal documents: reads content/legal/<key>.md, fills the tokens
// from the parsed env, parses to blocks, and collects the counsel markers
// still left. The only legal module that touches fs and env, so the pages and
// the tests can stay pure by injecting source and env.
import { readFileSync } from "node:fs";
import path from "node:path";

import { getEnv } from "@/lib/env";

import { findMarkers } from "./check";
import { parseLegalMarkdown, type LegalBlock } from "./markdown";
import { fillTokens, legalTokens, type LegalTokenEnv } from "./tokens";

export type LegalKey = "terms" | "privacy" | "refund";

export const LEGAL_KEYS: LegalKey[] = ["terms", "privacy", "refund"];

// The version the effective_date token is built from. Bump it when counsel
// signs off on new wording; formatLegalDate turns it into the visible date.
export const LEGAL_VERSION = "2026-11-01";

// The slice of lib/env the loader needs. Field names match the parsed env
// exactly, so getEnv() can be passed as is and tests can pass a hand made
// object instead.
export type LegalEnv = LegalTokenEnv;

export type LegalDocument = {
  key: LegalKey;
  // Text of the h1 block.
  title: string;
  blocks: LegalBlock[];
  // [[...]] texts left after filling, in document order.
  markers: string[];
};

export function readLegalSource(key: LegalKey): string {
  return readFileSync(path.join(process.cwd(), "content", "legal", key + ".md"), "utf8");
}

export function loadAllLegalSources(): Record<LegalKey, string> {
  const out = {} as Record<LegalKey, string>;
  for (const key of LEGAL_KEYS) {
    out[key] = readLegalSource(key);
  }
  return out;
}

function envFromGetEnv(): LegalEnv {
  const env = getEnv();
  return {
    LEGAL_OPERATOR_NAME: env.LEGAL_OPERATOR_NAME,
    LEGAL_SUPPORT_EMAIL: env.LEGAL_SUPPORT_EMAIL,
    LEGAL_SUPABASE_REGION: env.LEGAL_SUPABASE_REGION,
    LEGAL_VPS_PROVIDER: env.LEGAL_VPS_PROVIDER,
    STRIPE_MANAGED_PAYMENTS: env.STRIPE_MANAGED_PAYMENTS,
  };
}

// Tokens are filled before parsing so the parser never sees {{...}} syntax,
// and markers are collected from the filled text so they are exactly what a
// reader would still see.
export function loadLegalDocument(
  key: LegalKey,
  deps?: { source?: string; env?: LegalEnv },
): LegalDocument {
  const source = deps?.source ?? readLegalSource(key);
  const tokens = legalTokens({ env: deps?.env ?? envFromGetEnv(), version: LEGAL_VERSION });
  const filled = fillTokens(source, tokens);
  const blocks = parseLegalMarkdown(filled);
  const h1 = blocks.find((block) => block.kind === "h1");
  return { key, title: h1?.kind === "h1" ? h1.text : key, blocks, markers: findMarkers(filled) };
}
