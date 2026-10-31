// Operator tool: refund one Telegram Stars payment and close the matching
// Stars subscription row. Dry run by default; pass --yes to actually refund.
// Usage: bun run scripts/refund-stars.ts --user <telegram user id> --charge <charge id> [--yes]
// Never prints the bot token. Not imported by app code.
import { Api } from "grammy";
import { getEnv } from "../lib/env";
import { getSupabase } from "../lib/db/client";
import { createPendingActionsQueries } from "../lib/clarify/queries";
import { createSubscriptionsQueries } from "../lib/billing/subscriptions";

export const REFUND_USAGE =
  "Usage: bun run scripts/refund-stars.ts --user <telegram user id> --charge <charge id> [--yes]";

export type ParsedRefundArgs =
  | { ok: true; userId: number; chargeId: string; perform: boolean }
  | { ok: false; usage: string };

// Pure arg parsing so bad input never reaches Telegram or the database.
export function planRefund(argv: string[]): ParsedRefundArgs {
  let user: number | undefined;
  let charge: string | undefined;
  let perform = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--user") {
      user = Number(argv[i + 1]);
      i += 1;
    } else if (arg === "--charge") {
      charge = argv[i + 1];
      i += 1;
    } else if (arg === "--yes") {
      perform = true;
    } else {
      return { ok: false, usage: REFUND_USAGE };
    }
  }
  if (user === undefined || !Number.isSafeInteger(user) || user <= 0) {
    return { ok: false, usage: REFUND_USAGE };
  }
  if (charge === undefined || charge.trim().length === 0) {
    return { ok: false, usage: REFUND_USAGE };
  }
  return { ok: true, userId: user, chargeId: charge, perform };
}

export type RefundDeps = {
  refundStarPayment: (userId: number, chargeId: string) => Promise<unknown>;
  markSubscriptionCanceled: (userId: number, chargeId: string) => Promise<void>;
  recordBillingEvent: (id: string, provider: string, payload: Record<string, unknown>) => Promise<void>;
};

export type RefundOutcome =
  | { kind: "dry_run" }
  | { kind: "refunded" }
  | { kind: "failed"; message: string };

export async function refundStars(
  deps: RefundDeps,
  args: { userId: number; chargeId: string; perform: boolean },
  log: (message: string) => void = console.log,
): Promise<RefundOutcome> {
  const eventId = `stars:refund:${args.chargeId}`;
  if (!args.perform) {
    log(
      `Dry run: would refund charge ${args.chargeId} for Telegram user ${args.userId}, ` +
        `mark their Stars subscription canceled and record billing event ${eventId}. ` +
        "Run again with --yes to do it.",
    );
    return { kind: "dry_run" };
  }
  try {
    await deps.refundStarPayment(args.userId, args.chargeId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "failed", message };
  }
  // The money is already back with the student, so bookkeeping failures must
  // not undo anything, but they should be loud on the operator's terminal.
  try {
    await deps.markSubscriptionCanceled(args.userId, args.chargeId);
    await deps.recordBillingEvent(eventId, "stars", {
      telegram_user_id: args.userId,
      telegram_payment_charge_id: args.chargeId,
    });
  } catch (error) {
    log(
      `Refund done, but bookkeeping failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  log(`Refunded charge ${args.chargeId} for Telegram user ${args.userId}. Subscription marked canceled.`);
  return { kind: "refunded" };
}

async function markCanceledReal(telegramUserId: number, chargeId: string): Promise<void> {
  const client = getSupabase();
  const user = await createPendingActionsQueries(client).getUserByTelegramId(telegramUserId);
  if (user == null) {
    throw new Error(`No Settle user for Telegram id ${telegramUserId}`);
  }
  await createSubscriptionsQueries(client).markSubscriptionCanceled(user.id, "stars", chargeId);
}

async function main(): Promise<number> {
  const parsed = planRefund(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.usage);
    return 1;
  }
  const env = getEnv();
  const api = new Api(env.TELEGRAM_BOT_TOKEN);
  const client = getSupabase();
  const outcome = await refundStars(
    {
      refundStarPayment: (userId, chargeId) => api.refundStarPayment(userId, chargeId),
      markSubscriptionCanceled: markCanceledReal,
      recordBillingEvent: (id, provider, payload) =>
        createSubscriptionsQueries(client).recordBillingEvent({ id, provider, payload }),
    },
    parsed,
  );
  if (outcome.kind === "failed") {
    console.error(`Refund failed: ${outcome.message}`);
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
