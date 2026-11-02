import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { runLegalCheck } from "../../lib/legal/check";
import { legalTokens } from "../../lib/legal/tokens";
import { legalEnvFromRaw } from "../../scripts/check-legal";

// The script must run on a machine whose env only carries the five legal
// variables: no getEnv call, no Telegram, Stripe or database secrets.
describe("scripts/check-legal.ts env reading", () => {
  test("never calls getEnv", () => {
    const script = readFileSync(new URL("../../scripts/check-legal.ts", import.meta.url), "utf8");
    // The import would drag in the whole validated env; the script reads the
    // five legal variables straight from the raw env map instead.
    expect(script).not.toMatch(/from ["'][./]*lib\/env["']/);
    expect(script).not.toMatch(/\bgetEnv\s*\(/);
  });

  test("reads the five legal variables from an injected raw env", () => {
    const env = legalEnvFromRaw({
      LEGAL_OPERATOR_NAME: "  Sentinel Operator  ",
      LEGAL_SUPPORT_EMAIL: "legal-sentinel@example.com",
      LEGAL_SUPABASE_REGION: "ap-southeast-1",
      LEGAL_VPS_PROVIDER: "SentinelHost",
      STRIPE_MANAGED_PAYMENTS: "true",
    });
    expect(env.LEGAL_OPERATOR_NAME).toBe("Sentinel Operator");
    expect(env.LEGAL_SUPPORT_EMAIL).toBe("legal-sentinel@example.com");
    expect(env.LEGAL_SUPABASE_REGION).toBe("ap-southeast-1");
    expect(env.LEGAL_VPS_PROVIDER).toBe("SentinelHost");
    expect(env.STRIPE_MANAGED_PAYMENTS).toBe(true);
  });

  test("blank and absent values count as absent, and the flag defaults to false", () => {
    const env = legalEnvFromRaw({
      LEGAL_OPERATOR_NAME: "   ",
      STRIPE_MANAGED_PAYMENTS: "false",
    });
    expect(env.LEGAL_OPERATOR_NAME).toBeUndefined();
    expect(env.LEGAL_SUPPORT_EMAIL).toBeUndefined();
    expect(env.LEGAL_SUPABASE_REGION).toBeUndefined();
    expect(env.LEGAL_VPS_PROVIDER).toBeUndefined();
    expect(env.STRIPE_MANAGED_PAYMENTS).toBe(false);

    const empty = legalEnvFromRaw({});
    expect(empty.STRIPE_MANAGED_PAYMENTS).toBe(false);
  });

  test("the flag uses the lib/env convention: only exact true or false pass", () => {
    // Same as the zod enum in lib/env.ts: "TRUE", "1" and "yes" are invalid,
    // never a silent flip.
    for (const bad of ["TRUE", "False", "1", "yes", "on", "maybe"]) {
      expect(() => legalEnvFromRaw({ STRIPE_MANAGED_PAYMENTS: bad }), bad).toThrow(
        "STRIPE_MANAGED_PAYMENTS must be true or false",
      );
    }
  });

  test("a plain env with only the legal variables runs the whole check to exit 1", () => {
    const result = runLegalCheck({
      sources: {
        terms: "# T\n\nRun by {{operator_name}} at {{support_email}}.",
      },
      env: legalEnvFromRaw({ STRIPE_MANAGED_PAYMENTS: "false" }),
      version: "2026-11-01",
    });
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toContain("[[MISSING: LEGAL_OPERATOR_NAME]]");
  });

  test("a filled plain env runs the whole check to exit 0", () => {
    const env = legalEnvFromRaw({
      LEGAL_OPERATOR_NAME: "Sentinel Operator",
      LEGAL_SUPPORT_EMAIL: "legal-sentinel@example.com",
      LEGAL_SUPABASE_REGION: "ap-southeast-1",
      LEGAL_VPS_PROVIDER: "SentinelHost",
      STRIPE_MANAGED_PAYMENTS: "true",
    });
    const result = runLegalCheck({
      sources: {
        terms: "# T\n\nRun by {{operator_name}} at {{support_email}} in {{supabase_region}} on {{vps_provider}}.",
      },
      env,
      version: "2026-11-01",
    });
    expect(result.exitCode).toBe(0);
    expect(result.lines.join("\n")).toContain("terms.md: ok");
    // The flag flows through to the tokens: the managed sentence is the
    // seller-of-record one (checked on the tokens, because the check output
    // only ever prints problem excerpts, never filled text).
    const tokens = legalTokens({ env, version: "2026-11-01" });
    expect(tokens.stripe_role_sentence).toContain("seller of record");
  });

  test("no problem excerpt ever echoes a filled env value", () => {
    const result = runLegalCheck({
      sources: {
        terms: "# T\n\nRun by {{operator_name}} at {{support_email}}. TODO later.",
      },
      env: legalEnvFromRaw({
        LEGAL_OPERATOR_NAME: "Secretive Operator",
        LEGAL_SUPPORT_EMAIL: "legal-sentinel@example.com",
      }),
      version: "2026-11-01",
    });
    const text = result.lines.join("\n");
    expect(result.exitCode).toBe(1);
    expect(text).not.toContain("Secretive Operator");
    expect(text).not.toContain("legal-sentinel@example.com");
    expect(text).toContain("TODO");
  });
});
