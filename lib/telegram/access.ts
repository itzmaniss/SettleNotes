// Access policy for every Telegram entry point (webhook, long polling and the
// web login). Pure decision plus one lazy env-reading wrapper; the callers
// never read ALLOWED_TELEGRAM_IDS or the flags directly, so the open switch
// behaves identically everywhere.
import "server-only";
import { getEnv } from "@/lib/env";

export type AccessPolicy =
  | { mode: "allowlist"; allowedIds: number[]; reason: "default" | "blocked_billing_off" }
  | { mode: "open" };

export type AccessPolicyInputs = {
  allowlistEnabled: boolean;
  billingEnabled: boolean;
  allowedIds: number[];
};

// The safety rule: the bot only opens to everyone while billing is ON. With
// BILLING_ENABLED=false every user counts as Pro with unlimited AI at the
// owner's cost, so a request to open with billing off stays allowlist only and
// is flagged with reason "blocked_billing_off".
export function resolveAccessPolicy(input: AccessPolicyInputs): AccessPolicy {
  if (input.allowlistEnabled) {
    return { mode: "allowlist", allowedIds: input.allowedIds, reason: "default" };
  }
  if (input.billingEnabled) return { mode: "open" };
  return { mode: "allowlist", allowedIds: input.allowedIds, reason: "blocked_billing_off" };
}

// Bare id lists from older call sites keep working; they mean the default
// allowlist policy.
export function toAccessPolicy(access: AccessPolicy | number[]): AccessPolicy {
  if (Array.isArray(access)) {
    return { mode: "allowlist", allowedIds: access, reason: "default" };
  }
  return access;
}

// Open mode admits any identified sender. A sender without an id is still
// ignored by the callers before this runs (there is nobody to admit).
export function isAccessAllowed(
  telegramUserId: number | undefined,
  access: AccessPolicy | number[],
): boolean {
  if (telegramUserId === undefined) return false;
  const policy = toAccessPolicy(access);
  if (policy.mode === "open") return true;
  return policy.allowedIds.includes(telegramUserId);
}

let cachedPolicy: AccessPolicy | undefined;
let warnedBlocked = false;

function policyInputsFromEnv(): AccessPolicyInputs {
  const env = getEnv();
  return {
    allowlistEnabled: env.ALLOWLIST_ENABLED,
    billingEnabled: env.BILLING_ENABLED,
    allowedIds: env.ALLOWED_TELEGRAM_IDS,
  };
}

// The one loud line when someone asked to open the bot while billing is off.
// Fired once per process (getAccessPolicy is called per bot creation, not per
// request), log injected so tests can capture it.
export function announceBlockedOpen(
  policy: AccessPolicy,
  log: (message: string) => void = console.error,
): AccessPolicy {
  if (policy.mode === "allowlist" && policy.reason === "blocked_billing_off" && !warnedBlocked) {
    warnedBlocked = true;
    log(
      "[access] ALLOWLIST_ENABLED=false was ignored because BILLING_ENABLED=false. With billing off every user counts as Pro with unlimited AI at your cost, so the bot stays on the allowlist. Turn billing on first, then open the bot.",
    );
  }
  return policy;
}

// The one lazy helper every call site uses. Reads env at call time, never at
// import, and caches the resolved policy so the blocked pairing warns once
// per process instead of once per request.
export function getAccessPolicy(): AccessPolicy {
  cachedPolicy ??= resolveAccessPolicy(policyInputsFromEnv());
  return announceBlockedOpen(cachedPolicy);
}
