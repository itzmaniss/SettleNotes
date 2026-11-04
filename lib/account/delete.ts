import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import { getSupabase } from "@/lib/db/client";
import { EXPIRED_PATH } from "@/lib/auth/paths";
import { blockerKind, isActiveAt } from "@/lib/privacy/blockers";
import { fetchPaged } from "@/lib/privacy/query";
import { eraseUser, EraseStepError, type EraseReport } from "@/lib/privacy/erase";
import { clearSessionCookie, type CookieStoreLike } from "./session-cookie";

// The guarded self serve account deletion, split out of the server action so
// tests run it on fakes. The caller (app/(dashboard)/account/actions.ts)
// resolves the user id from the session only; nothing here trusts the form
// beyond the confirmation word and tick, and nothing here targets any user
// but that one.

export const DELETE_CONFIRM_WORD = "DELETE";
export const DELETE_CONFIRM_BOX = "on";

export type BlockingKind = "stripe" | "stars" | "other";

export type DeleteOutcome =
  | { kind: "word_needed" }
  | { kind: "box_needed" }
  | { kind: "cancel_first"; blocking: BlockingKind }
  | { kind: "deleted" }
  | { kind: "failed" };

export type SubscriptionRowLike = {
  provider: string;
  provider_ref: string;
  plan: string;
  status: string;
  current_period_end: string | null;
};

export type DeleteAccountDeps = {
  listSubscriptions: (userId: string) => Promise<SubscriptionRowLike[]>;
  erase: (args: { userId: string; telegramUserId: number | undefined }) => Promise<EraseReport>;
};

// Real deps, built lazily inside the action, never at import time. The
// telegramUserId lets the billing payload scrub find the refund bookkeeping
// rows, exactly like the operator script does.
export function realDeleteAccountDeps(): DeleteAccountDeps {
  return {
    listSubscriptions: (userId) =>
      fetchPaged<SubscriptionRowLike>(
        getSupabase(),
        "subscriptions",
        "provider,provider_ref,plan,status,current_period_end",
        [{ column: "user_id", op: "eq", value: userId }],
      ),
    erase: async ({ userId, telegramUserId }) => {
      const client: SupabaseClient = getSupabase();
      return eraseUser(
        {
          client,
          storage: client.storage,
          bucket: env.SUPABASE_STORAGE_BUCKET,
          telegramUserId,
        },
        { userId, dryRun: false, force: false },
      );
    },
  };
}

// A subscription blocks deletion while a charge could still happen:
// active or trialing with a period that has not ended, or past_due (a
// failed payment can still recover and charge). Canceled subscriptions and
// expired periods never block. Statuses beyond the stored three
// (active, canceled, past_due) are treated the same way: trialing blocks
// while the period runs.
const BLOCKING_STATUSES = new Set(["active", "trialing", "past_due"]);

function blockingRows(rows: SubscriptionRowLike[], now: Date): SubscriptionRowLike[] {
  return rows.filter((row) => {
    if (!BLOCKING_STATUSES.has(row.status)) return false;
    if (row.status === "past_due") return true;
    return isActiveAt(row, now);
  });
}

// The banner wording picks the subscription the student can act on
// themselves first: a Stripe plan via the Billing page, a Stars plan in
// Telegram, anything else gets the generic line.
function strongestBlockingKind(rows: SubscriptionRowLike[]): BlockingKind {
  const kinds = rows.map((row) => blockerKind(row.provider, row.provider_ref));
  if (kinds.includes("stripe")) return "stripe";
  if (kinds.includes("stars")) return "stars";
  return "other";
}

function outcomeForReport(report: EraseReport): DeleteOutcome {
  switch (report.status) {
    case "erased":
    case "nothing_to_delete":
      return { kind: "deleted" };
    case "blocked":
      // The pre-check passed but a subscription blocked anyway (a race).
      // Same calm answer as the pre-check, without the Stripe ids.
      return { kind: "cancel_first", blocking: "other" };
    default:
      return { kind: "failed" };
  }
}

export async function runAccountDeletion(
  deps: DeleteAccountDeps,
  args: {
    userId: string;
    telegramUserId: number | undefined;
    word: string | null;
    checkbox: string | null;
    now: Date;
  },
): Promise<DeleteOutcome> {
  // Never trust the client: both confirmations are re-checked here.
  const word = (args.word ?? "").trim();
  if (word !== DELETE_CONFIRM_WORD) return { kind: "word_needed" };
  if (args.checkbox !== DELETE_CONFIRM_BOX) return { kind: "box_needed" };

  const rows = await deps.listSubscriptions(args.userId);
  const blocking = blockingRows(rows, args.now);
  if (blocking.length > 0) {
    return { kind: "cancel_first", blocking: strongestBlockingKind(blocking) };
  }

  try {
    const report = await deps.erase({ userId: args.userId, telegramUserId: args.telegramUserId });
    return outcomeForReport(report);
  } catch (error) {
    // One line, no personal data: not the user id, not the error detail.
    const step = error instanceof EraseStepError ? error.step : "unknown";
    console.error(`[account] self serve deletion stopped at step ${step}; the student can retry.`);
    return { kind: "failed" };
  }
}

// ---- The server action bodies, with every side effect injected -------------
// The "use server" file wires the real Next pieces (cookies, redirect, the
// session gate) lazily inside the action; tests inject fakes and can run
// these without any module mocks.

export type AccountActionDeps = {
  // Resolves the user id from the signed session, or throws the way
  // requireSessionUser does when the session or the user row is gone.
  session: () => Promise<string>;
  // The users row for the session user, or null when it is gone.
  getUser: (userId: string) => Promise<{ telegram_user_id: number } | null>;
  deletion: DeleteAccountDeps;
  cookies: () => Promise<CookieStoreLike>;
  baseUrl: () => string;
  // The real redirect throws NEXT_REDIRECT; tests capture the location.
  redirectTo: (location: string) => never;
};

export async function performLogOut(deps: AccountActionDeps): Promise<void> {
  clearSessionCookie(await deps.cookies(), deps.baseUrl());
  deps.redirectTo("/login");
}

export async function performDeleteAccount(
  deps: AccountActionDeps,
  formData: FormData,
): Promise<void> {
  const userId = await deps.session();
  // The row is needed for the Telegram id, which the billing payload scrub
  // needs to find the refund bookkeeping rows, same as the operator script.
  const row = await deps.getUser(userId);
  if (row == null) deps.redirectTo(EXPIRED_PATH);

  const raw = (key: string): string | null => {
    const value = formData.get(key);
    return typeof value === "string" ? value : null;
  };

  const outcome = await runAccountDeletion(deps.deletion, {
    userId,
    telegramUserId: row.telegram_user_id,
    word: raw("confirm_word"),
    checkbox: raw("confirm_box"),
    now: new Date(),
  });

  switch (outcome.kind) {
    case "word_needed":
      deps.redirectTo("/account?status=word_needed");
      break;
    case "box_needed":
      deps.redirectTo("/account?status=box_needed");
      break;
    case "cancel_first":
      deps.redirectTo(`/account?status=cancel_first&kind=${outcome.blocking}`);
      break;
    case "failed":
      deps.redirectTo("/account?status=delete_failed");
      break;
    case "deleted":
      clearSessionCookie(await deps.cookies(), deps.baseUrl());
      deps.redirectTo("/account-deleted");
      break;
  }
}
