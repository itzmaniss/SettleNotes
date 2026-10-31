// Stale account sweep: pure classification plus the read only queries behind
// scripts/stale-accounts.ts. Read only by contract: nothing in this file, or
// in the script that calls it, may insert, update, delete, upsert, rpc or
// remove; the test in tests/privacy/stale.test.ts scans both sources to pin
// that. Activity is the latest of the account's created_at, its latest upload,
// its latest task event and its latest usage event.
import type { SupabaseClient } from "@supabase/supabase-js";
import { applyFilters, type PrivacyFilter } from "./query";
import { isActiveAt } from "./blockers";
import {
  OWNED_TABLES,
  countOwnedRows,
  type OwnedCounts,
} from "./counts";

export const DEFAULT_STALE_DAYS = 365;
export const STALE_USAGE = "Usage: bun run scripts/stale-accounts.ts [--days 365]";

export const DAY_MS = 24 * 60 * 60 * 1000;
// PostgREST answers at most 1000 rows per request; pages of 200 with a hard
// page bound stop a broken backend from hanging the operator's terminal.
export const STALE_PAGE_SIZE = 200;
export const MAX_STALE_PAGES = 500;

export type ParsedStaleArgs = { ok: true; days: number } | { ok: false; usage: string };

// Pure arg parsing so a mistyped threshold never reaches the database.
export function parseStaleArgs(argv: string[]): ParsedStaleArgs {
  let days: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--days") {
      days = Number(argv[i + 1]);
      i += 1;
    } else {
      return { ok: false, usage: STALE_USAGE };
    }
  }
  if (days === undefined) days = DEFAULT_STALE_DAYS;
  if (!Number.isSafeInteger(days) || days <= 0) return { ok: false, usage: STALE_USAGE };
  return { ok: true, days };
}

export type UserActivity = { uploads: string[]; taskEvents: string[]; usageEvents: string[] };

// Pure: the newest of the account row and the three activity feeds. A missing
// or unparseable timestamp simply does not compete.
export function latestActivityMs(user: { created_at: string }, activity: UserActivity): number {
  const candidates = [user.created_at, ...activity.uploads, ...activity.taskEvents, ...activity.usageEvents];
  let latest = Number.NEGATIVE_INFINITY;
  for (const value of candidates) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms) && ms > latest) latest = ms;
  }
  return latest;
}

export function daysInactive(lastActivityMs: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - lastActivityMs) / DAY_MS));
}

// Boundary rule: on the exact day the threshold is reached the account counts
// as stale, not a day later.
export function isStale(lastActivityMs: number, nowMs: number, days: number): boolean {
  return nowMs - lastActivityMs >= days * DAY_MS;
}

export type SubscriptionLivenessRow = {
  provider: string;
  provider_ref: string;
  plan: string;
  status: string;
  current_period_end: string | null;
};

// Any subscription that is active and still inside its paid period keeps the
// account off the list, whatever the account's idle time. The same rule as
// the erase blockers: active plus a period end in the future.
export function hasLiveSubscription(rows: SubscriptionLivenessRow[], now: Date): boolean {
  return rows.some((row) => row.status === "active" && isActiveAt(row, now));
}

export type StaleUserRow = { id: string; telegram_user_id: number; created_at: string };

export type StaleAccount = {
  user: StaleUserRow;
  lastActivityMs: number;
  inactiveDays: number;
  counts: OwnedCounts;
};

export type SweepResult = { checked: number; days: number; accounts: StaleAccount[] };

// Paged select on a stable order until a short page, with a hard page bound.
async function fetchAllPaged<T>(
  client: SupabaseClient,
  table: string,
  columns: string,
  filters: PrivacyFilter[],
  order = "created_at",
): Promise<T[]> {
  const rows: T[] = [];
  let offset = 0;
  for (let page = 1; ; page++) {
    if (page > MAX_STALE_PAGES) {
      throw new Error(`sweep fetch on ${table} did not end after ${MAX_STALE_PAGES} pages; stopping`);
    }
    const base = client.from(table).select(columns);
    const filtered = applyFilters(base, filters);
    const ranged = filtered.order(order).range(offset, offset + STALE_PAGE_SIZE - 1);
    const { data, error } = await ranged;
    if (error) throw new Error(`sweep fetch on ${table} failed: ${error.message}`);
    const pageRows = (data ?? []) as T[];
    rows.push(...pageRows);
    if (pageRows.length < STALE_PAGE_SIZE) return rows;
    offset += STALE_PAGE_SIZE;
  }
}

const eqUser = (userId: string): PrivacyFilter[] => [{ column: "user_id", op: "eq", value: userId }];

// Per account activity feeds. task_events hang off tasks, so the user filter
// goes through the inner join, exactly as in countOwnedRows; only created_at
// is selected, so no content can reach the terminal.
export async function fetchUserActivity(client: SupabaseClient, userId: string): Promise<UserActivity> {
  const uploads = await fetchAllPaged<{ created_at: string }>(client, "uploads", "created_at", eqUser(userId));
  const taskEvents = await fetchAllPaged<{ created_at: string }>(
    client,
    "task_events",
    "created_at,tasks!inner(user_id)",
    [{ column: "tasks.user_id", op: "eq", value: userId }],
  );
  const usageEvents = await fetchAllPaged<{ created_at: string }>(
    client,
    "usage_events",
    "created_at",
    eqUser(userId),
  );
  return {
    uploads: uploads.map((row) => row.created_at),
    taskEvents: taskEvents.map((row) => row.created_at),
    usageEvents: usageEvents.map((row) => row.created_at),
  };
}

export async function fetchSubscriptionLiveness(
  client: SupabaseClient,
  userId: string,
): Promise<SubscriptionLivenessRow[]> {
  return fetchAllPaged<SubscriptionLivenessRow>(
    client,
    "subscriptions",
    "provider,provider_ref,plan,status,current_period_end",
    eqUser(userId),
  );
}

// The whole sweep. Every query filters on the account's own id, so another
// student's activity can never count for someone else.
export async function findStaleAccounts(
  client: SupabaseClient,
  args: { days: number; now: Date },
): Promise<SweepResult> {
  const users = await fetchAllPaged<StaleUserRow>(
    client,
    "users",
    "id,telegram_user_id,created_at",
    [],
    "created_at",
  );
  const accounts: StaleAccount[] = [];
  for (const user of users) {
    const subs = await fetchSubscriptionLiveness(client, user.id);
    if (hasLiveSubscription(subs, args.now)) continue;
    const activity = await fetchUserActivity(client, user.id);
    const last = latestActivityMs(user, activity);
    if (!isStale(last, args.now.getTime(), args.days)) continue;
    const counts = await countOwnedRows(client, user.id);
    accounts.push({
      user,
      lastActivityMs: last,
      inactiveDays: daysInactive(last, args.now.getTime()),
      counts,
    });
  }
  accounts.sort((a, b) => a.lastActivityMs - b.lastActivityMs);
  return { checked: users.length, days: args.days, accounts };
}

// Pure rendering: short ids, Telegram ids (the operator needs them to run
// delete-user) and counts. Never names, never content.
export function formatStaleSweep(result: SweepResult): string[] {
  const lines: string[] = [];
  lines.push(
    `Stale account sweep: accounts with no activity for ${result.days} days or more, and no live subscription.`,
  );
  lines.push(`Checked ${result.checked} accounts; ${result.accounts.length} look stale.`);
  lines.push("");
  for (const account of result.accounts) {
    lines.push(`user ${account.user.id.slice(0, 8)}: last activity ${account.inactiveDays} days ago`);
    lines.push(`  telegram id ${account.user.telegram_user_id}`);
    lines.push("  rows the erase would remove:");
    for (const { table, note } of OWNED_TABLES) {
      const suffix = note === undefined ? "" : ` (${note})`;
      lines.push(`    ${table} ${account.counts[table]}${suffix}`);
    }
    lines.push("  next step, dry run first:");
    lines.push(`    bun run scripts/delete-user.ts --telegram-id ${account.user.telegram_user_id}`);
    lines.push("");
  }
  const summary =
    result.accounts.length === 1
      ? "Summary: 1 stale account"
      : `Summary: ${result.accounts.length} stale accounts`;
  lines.push(`${summary} of ${result.checked} checked (threshold ${result.days} days).`);
  lines.push("This sweep only reads. Nothing was changed.");
  lines.push("An account on this list is a prompt to review, never an instruction to erase.");
  return lines;
}
