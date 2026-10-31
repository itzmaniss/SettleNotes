// The erase itself. The order matters and every step is repeatable:
// blockers, billing payload scrub, storage files, the users row, verify.
// A failure in a later step keeps the earlier steps' results and the caller
// tells the operator to simply run again; the next run re-lists what is left
// and finishes the job.
import type { SupabaseClient } from "@supabase/supabase-js";
import { allZero, countOwnedRows, nonzeroEntries, type OwnedCounts } from "./counts";
import { activeSubscriptionBlockers, type SubscriptionBlocker } from "./blockers";
import { findBillingEventsForUser, scrubBillingEvents } from "./billing-events";
import {
  listStoredFiles,
  removeStoredFiles,
  StorageRemoveError,
  type StorageApi,
} from "./storage";

export type EraseStep = "blockers" | "scrub" | "storage" | "delete_user" | "verify";

export type EraseStatus =
  | "dry_run"
  | "blocked"
  | "erased"
  | "nothing_to_delete"
  | "incomplete"
  | "failed";

export type EraseReport = {
  status: EraseStatus;
  userId: string;
  completedSteps: EraseStep[];
  blockers: SubscriptionBlocker[];
  before?: OwnedCounts;
  after?: OwnedCounts;
  filesBefore: number;
  filesAfter?: number;
  filesRemoved: number;
  eventsMatched: number;
  eventsScrubbed: number;
  message?: string;
};

export class EraseStepError extends Error {
  readonly step: EraseStep;
  readonly report: EraseReport;

  constructor(step: EraseStep, report: EraseReport, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Erasure stopped at step ${step}: ${detail}`);
    this.name = "EraseStepError";
    this.step = step;
    this.report = report;
  }
}

export type EraseDeps = {
  client: SupabaseClient;
  storage: StorageApi;
  bucket: string;
  // Refund bookkeeping rows carry the Telegram id rather than the uuid, so
  // passing it here lets the scrub find and minimise those rows too.
  telegramUserId?: number;
  now?: () => Date;
};

export type EraseArgs = { userId: string; dryRun: boolean; force?: boolean };

async function userRowExists(client: SupabaseClient, userId: string): Promise<boolean> {
  const { data, error } = await client.from("users").select("id").eq("id", userId).maybeSingle();
  if (error) throw new Error(`user lookup failed: ${error.message}`);
  return data != null;
}

export async function eraseUser(deps: EraseDeps, args: EraseArgs): Promise<EraseReport> {
  const now = (deps.now ?? (() => new Date()))();
  const completed: EraseStep[] = [];

  // 1. Active subscriptions block the erase unless forced. A dry run writes
  // nothing, so it looks past the block and reports the plan including the
  // blockers; the refusal applies to the destructive path.
  const blockers = await activeSubscriptionBlockers(deps.client, args.userId, now);
  completed.push("blockers");
  if (blockers.length > 0 && args.force !== true && args.dryRun !== true) {
    return {
      status: "blocked",
      userId: args.userId,
      completedSteps: [...completed],
      blockers,
      filesBefore: 0,
      filesRemoved: 0,
      eventsMatched: 0,
      eventsScrubbed: 0,
    };
  }

  // Look before touching: counts, files and billing events that would change.
  const before = await countOwnedRows(deps.client, args.userId);
  const filesBefore = await listStoredFiles(deps.storage, deps.bucket, args.userId);
  const events = await findBillingEventsForUser(deps.client, args.userId, {
    telegramUserId: deps.telegramUserId,
  });
  const exists = await userRowExists(deps.client, args.userId);

  if (!exists && allZero(before) && filesBefore.length === 0 && events.length === 0) {
    return {
      status: "nothing_to_delete",
      userId: args.userId,
      completedSteps: [...completed],
      blockers,
      before,
      filesBefore: 0,
      filesRemoved: 0,
      eventsMatched: events.length,
      eventsScrubbed: 0,
    };
  }

  if (args.dryRun) {
    return {
      status: "dry_run",
      userId: args.userId,
      completedSteps: [...completed],
      blockers,
      before,
      filesBefore: filesBefore.length,
      filesRemoved: 0,
      eventsMatched: events.length,
      eventsScrubbed: 0,
    };
  }

  // 2. Billing events: rows stay, payloads shrink to the accounting minimum.
  const scrub = await scrubBillingEvents(deps.client, args.userId, {
    telegramUserId: deps.telegramUserId,
  });
  completed.push("scrub");

  // 3. Storage objects, in batches. A half finished removal is fine: the
  // report carries how many batches went through and a rerun finishes it.
  let filesRemoved = 0;
  try {
    const removed = await removeStoredFiles(deps.storage, deps.bucket, filesBefore);
    filesRemoved = removed.length;
  } catch (cause) {
    if (cause instanceof StorageRemoveError) filesRemoved = cause.removed.length;
    throw new EraseStepError(
      "storage",
      {
        status: "failed",
        userId: args.userId,
        completedSteps: [...completed],
        blockers,
        before,
        filesBefore: filesBefore.length,
        filesRemoved,
        eventsMatched: events.length,
        eventsScrubbed: scrub.scrubbed,
      },
      cause,
    );
  }
  completed.push("storage");

  // 4. The users row; every foreign key cascade does the rest.
  try {
    const { error } = await deps.client.from("users").delete().eq("id", args.userId);
    if (error) throw new Error(error.message);
  } catch (cause) {
    throw new EraseStepError(
      "delete_user",
      {
        status: "failed",
        userId: args.userId,
        completedSteps: [...completed],
        blockers,
        before,
        filesBefore: filesBefore.length,
        filesRemoved: filesBefore.length,
        eventsMatched: events.length,
        eventsScrubbed: scrub.scrubbed,
      },
      cause,
    );
  }
  completed.push("delete_user");

  // 5. Verify: zero rows everywhere and an empty storage prefix.
  const after = await countOwnedRows(deps.client, args.userId);
  const filesAfter = await listStoredFiles(deps.storage, deps.bucket, args.userId);
  completed.push("verify");

  const leftover = nonzeroEntries(after);
  if (leftover.length > 0 || filesAfter.length > 0) {
    const rowsText = leftover.map(([table, n]) => `${table} ${n}`).join(", ");
    return {
      status: "incomplete",
      userId: args.userId,
      completedSteps: [...completed],
      blockers,
      before,
      after,
      filesBefore: filesBefore.length,
      filesAfter: filesAfter.length,
      filesRemoved: filesBefore.length,
      eventsMatched: events.length,
      eventsScrubbed: scrub.scrubbed,
      message: `verification found rows left over: ${rowsText || "none"}; files left over: ${filesAfter.length}`,
    };
  }

  return {
    status: "erased",
    userId: args.userId,
    completedSteps: [...completed],
    blockers,
    before,
    after,
    filesBefore: filesBefore.length,
    filesAfter: 0,
    filesRemoved: filesBefore.length,
    eventsMatched: events.length,
    eventsScrubbed: scrub.scrubbed,
  };
}
