// Operator tool: erase one student's data at their request. Dry run by
// default; --yes erases, --force ignores active subscription blockers.
// Usage: bun run scripts/delete-user.ts --telegram-id <id> [--yes] [--force]
//
// SAFETY: the subject is resolved from the Telegram id only, and only when it
// matches exactly one account. Every step is repeatable: a failed run can be
// run again, and the verify step reports anything left over.
// PRIVACY: output shows the account as `user <first 8 characters of the uuid>`
// plus counts. Never the name, the Telegram id, a username or any content.
// Not imported by app code. Runs under bun only.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "../lib/db/client";
import { getEnv } from "../lib/env";
import { SubjectResolutionError, resolveSubject, shortId } from "../lib/privacy/subject";
import { OWNED_TABLES, countOwnedRows, nonzeroEntries, type OwnedCounts } from "../lib/privacy/counts";
import { listStoredFiles, type StorageApi } from "../lib/privacy/storage";
import {
  activeSubscriptionBlockers,
  type SubscriptionBlocker,
} from "../lib/privacy/blockers";
import { findBillingEventsForUser } from "../lib/privacy/billing-events";
import { EraseStepError, eraseUser, type EraseReport } from "../lib/privacy/erase";

export const DELETE_USAGE =
  "Usage: bun run scripts/delete-user.ts --telegram-id <id> [--yes] [--force]";

export type ParsedDeleteArgs =
  | { ok: true; telegramId: number; yes: boolean; force: boolean }
  | { ok: false; usage: string };

// Pure arg parsing so a mistyped id can never reach the database.
export function parseDeleteArgs(argv: string[]): ParsedDeleteArgs {
  let telegramId: number | undefined;
  let yes = false;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--telegram-id") {
      telegramId = Number(argv[i + 1]);
      i += 1;
    } else if (arg === "--yes") {
      yes = true;
    } else if (arg === "--force") {
      force = true;
    } else {
      return { ok: false, usage: DELETE_USAGE };
    }
  }
  if (telegramId === undefined || !Number.isSafeInteger(telegramId) || telegramId <= 0) {
    return { ok: false, usage: DELETE_USAGE };
  }
  return { ok: true, telegramId, yes, force };
}

export type DeleteDeps = {
  client: SupabaseClient;
  storage: StorageApi;
  bucket: string;
  log: (line: string) => void;
  error: (line: string) => void;
};

function countsLines(counts: OwnedCounts): string[] {
  return OWNED_TABLES.map(({ table, note }) => {
    const suffix = note === undefined ? "" : ` (${note})`;
    return `  ${table} ${counts[table]}${suffix}`;
  });
}

function blockerLines(blockers: SubscriptionBlocker[]): string[] {
  return blockers.map((b) => `active subscription (${b.kind}): ${b.instruction}`);
}

// The whole flow with injected deps so tests run on fakes. Returns the
// process exit code.
export async function runDelete(
  deps: DeleteDeps,
  args: { telegramId: number; yes: boolean; force: boolean },
): Promise<number> {
  const { log, error } = deps;
  let userId: string;
  try {
    userId = await resolveSubject(deps.client, { telegramId: args.telegramId });
  } catch (err) {
    if (err instanceof SubjectResolutionError) {
      if (err.code === "not_found") {
        log("No Settle account exists for this Telegram id. Nothing to delete.");
        return 0;
      }
      error(err.message);
      return 1;
    }
    throw err;
  }

  const [counts, files, events, blockers] = await Promise.all([
    countOwnedRows(deps.client, userId),
    listStoredFiles(deps.storage, deps.bucket, userId),
    findBillingEventsForUser(deps.client, userId, { telegramUserId: args.telegramId }),
    activeSubscriptionBlockers(deps.client, userId, new Date()),
  ]);

  log(`user ${shortId(userId)}`);
  log("rows that the erase removes (the cascade follows the users row):");
  for (const line of countsLines(counts)) log(line);
  log(`stored files to remove: ${files.length}`);
  log(
    `billing events to scrub: ${events.length} (payloads minimised, rows kept for accounting and dedupe)`,
  );
  for (const line of blockerLines(blockers)) log(line);

  if (!args.yes) {
    log("Dry run: nothing has been changed. Run again with --yes to erase this account.");
    return 0;
  }

  if (blockers.length > 0 && args.force) {
    log(
      "WARNING: --force is ignoring active subscriptions. The student may still be charged by Stripe or by Telegram.",
    );
  }

  let report: EraseReport;
  try {
    report = await eraseUser(
      {
        client: deps.client,
        storage: deps.storage,
        bucket: deps.bucket,
        telegramUserId: args.telegramId,
      },
      { userId, dryRun: false, force: args.force },
    );
  } catch (err) {
    if (err instanceof EraseStepError) {
      error(`Stopped at step ${err.step}.`);
      const partial = err.report;
      if (partial.filesRemoved > 0) log(`stored files removed before the stop: ${partial.filesRemoved}`);
      if (partial.eventsScrubbed > 0) log(`billing events scrubbed before the stop: ${partial.eventsScrubbed}`);
      error(`Already done: ${partial.completedSteps.join(", ")}.`);
      error("Nothing is lost by stopping. Run the same command again when ready; it is safe to repeat.");
      return 1;
    }
    throw err;
  }

  if (report.status === "blocked") {
    for (const line of blockerLines(report.blockers)) error(line);
    error(
      "The erase is blocked until these are cancelled or expired. Handle them and run again, or use --force to ignore them.",
    );
    return 1;
  }
  if (report.status === "nothing_to_delete") {
    log("This account is already erased. Nothing to delete.");
    return 0;
  }
  if (report.status === "incomplete") {
    for (const [table, n] of nonzeroEntries(report.after ?? ({} as OwnedCounts))) {
      error(`rows remain in ${table}: ${n}`);
    }
    if ((report.filesAfter ?? 0) > 0) error(`files remain: ${report.filesAfter}`);
    error("Run the same command again; it is safe to repeat and will finish the job.");
    return 1;
  }

  log(`Erasure complete and verified for user ${shortId(userId)}.`);
  log(`stored files removed: ${report.filesRemoved}`);
  log(`billing events scrubbed: ${report.eventsScrubbed} (rows kept, payloads minimal)`);
  log("verification: every owned table now counts zero and the storage prefix is empty.");
  log("Reply to the student by email so they know the request is done.");
  log("Record the request date and today's date in your own request log.");
  return 0;
}

async function main(): Promise<number> {
  const parsed = parseDeleteArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.usage);
    return 1;
  }
  const env = getEnv(); // fail fast with the normal env validation message
  const client = getSupabase();
  return runDelete(
    {
      client,
      storage: client.storage,
      bucket: env.SUPABASE_STORAGE_BUCKET,
      log: console.log,
      error: console.error,
    },
    parsed,
  );
}

if (import.meta.main) {
  process.exit(await main());
}
