// Owner stats: read only aggregates for the operator of a live deployment.
// Usage: bun run scripts/stats.ts [--json] [--days N]
//
// SAFETY: this script runs SELECT queries only. No row is ever written,
// changed or removed, so it is safe against the production database. The test
// in tests/scripts/stats.test.ts scans this file's source to pin that.
//
// PRIVACY: the output contains aggregates only. Names, Telegram ids,
// usernames, message text and secrets are never selected and never printed.
//
// LARGE TABLES: PostgREST returns at most 1000 rows per request, so every
// multi row fetch goes through fetchAll below, which pages with .range() on
// a stable order (created_at, then id) until a short page comes back. Pure
// counts use head count queries instead, which are exact at any size.

import { getSupabase } from "../lib/db/client";
import { getEnv } from "../lib/env";
import { PLANS } from "../lib/billing/plans";

type Client = ReturnType<typeof getSupabase>;

const PAGE_SIZE = 1000;
const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;
const RECURRING_OCCURRENCES = 3;

export type StatsArgs = { json: boolean; days: number };

export function parseStatsArgs(argv: string[]): StatsArgs {
  let json = false;
  let days = 7;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--days") {
      const parsed = Number(argv[i + 1]);
      if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isSafeInteger(parsed)) {
        throw new Error("--days needs a positive whole number");
      }
      days = parsed;
      i += 1;
    } else {
      throw new Error(`Unknown argument ${arg}. Usage: bun run scripts/stats.ts [--json] [--days N]`);
    }
  }
  return { json, days };
}

// ---- shared row shapes (only the columns this script selects) --------------

export type UploadLite = { kind: string; status: string; user_id: string };
export type TaskLite = { status: string; origin: string };
export type StarterLite = { type: string };
export type WeakSpotLite = { occurrences: number };
export type AiCallLite = {
  user_id: string | null;
  purpose: string;
  cost_usd: number | null;
  ok: boolean;
  created_at: string;
};
export type SubscriptionLite = { provider: string; plan: string; provider_ref: string };
export type UsageLite = { feature: string };

// ---- pure helpers -----------------------------------------------------------

export function countBy<T>(rows: T[], key: (row: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const k = key(row);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

export function countDistinct(values: Array<string | null>): number {
  return new Set(values.filter((v) => v != null)).size;
}

// 00:00 Singapore time today, as a UTC instant. SGT is fixed UTC+8.
export function sgtDayStart(now: Date): Date {
  const shifted = new Date(now.getTime() + SGT_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - SGT_OFFSET_MS);
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export type AiCallsSummary = {
  count: number;
  failures: number;
  failureRate: number;
  totalCostUsd: number;
  todayCostUsd: number;
  usersWithCalls: number;
  avgCostPerUserUsd: number;
  byPurpose: Record<string, { count: number; costUsd: number; failures: number }>;
};

export function summarizeAiCalls(rows: AiCallLite[], now: Date): AiCallsSummary {
  const todayStart = sgtDayStart(now);
  let totalCost = 0;
  let todayCost = 0;
  let failures = 0;
  const byPurpose: Record<string, { count: number; costUsd: number; failures: number }> = {};
  for (const row of rows) {
    const cost = row.cost_usd ?? 0;
    totalCost += cost;
    if (new Date(row.created_at).getTime() >= todayStart.getTime()) todayCost += cost;
    if (!row.ok) failures += 1;
    const bucket = byPurpose[row.purpose] ?? { count: 0, costUsd: 0, failures: 0 };
    bucket.count += 1;
    bucket.costUsd += cost;
    if (!row.ok) bucket.failures += 1;
    byPurpose[row.purpose] = bucket;
  }
  for (const bucket of Object.values(byPurpose)) bucket.costUsd = round2(bucket.costUsd);
  const users = countDistinct(rows.map((row) => row.user_id));
  return {
    count: rows.length,
    failures,
    failureRate: rows.length === 0 ? 0 : round2((failures / rows.length) * 100),
    totalCostUsd: round2(totalCost),
    todayCostUsd: round2(todayCost),
    usersWithCalls: users,
    avgCostPerUserUsd: users === 0 ? 0 : round2(totalCost / users),
    byPurpose,
  };
}

export type SubscriptionsSummary = {
  activeByProvider: Record<string, number>;
  activeByPlan: Record<string, number>;
  stripeRecurring: number;
  stripePaynow: number;
  starsActive: number;
  // The subscriptions row does not record monthly vs yearly, so the honest
  // estimate is a band: every recurring Stripe subscriber billed at the
  // monthly price at most, at the yearly price broken into months at least.
  mrrEstimate: { currency: "SGD" | "USD"; lower: number; upper: number } | null;
  // Stars are not converted to money: just subscribers times the Stars price.
  starsPerMonth: number | null;
};

export function summarizeSubscriptions(rows: SubscriptionLite[]): SubscriptionsSummary {
  const price = PLANS.pro.price;
  const recurring = rows.filter((row) => row.provider === "stripe" && !row.provider_ref.startsWith("paynow:"));
  const paynow = rows.filter((row) => row.provider === "stripe" && row.provider_ref.startsWith("paynow:"));
  const stars = rows.filter((row) => row.provider === "stars");
  return {
    activeByProvider: countBy(rows, (row) => row.provider),
    activeByPlan: countBy(rows, (row) => row.plan),
    stripeRecurring: recurring.length,
    stripePaynow: paynow.length,
    starsActive: stars.length,
    mrrEstimate:
      recurring.length === 0
        ? null
        : {
            currency: price.currency,
            lower: round2((recurring.length * price.yearly) / 12),
            upper: round2(recurring.length * price.monthly),
          },
    starsPerMonth: price.stars == null ? null : stars.length * price.stars.monthly,
  };
}

// ---- the whole stats object -------------------------------------------------

export type SettleStats = {
  generatedAt: string;
  windowDays: number;
  users: { total: number; new24h: number; newWindow: number; withUploads: number };
  uploads: {
    total: number;
    byKind: Record<string, number>;
    byStatus: Record<string, number>;
  };
  tasks: { total: number; byStatus: Record<string, number>; byOrigin: Record<string, number> };
  starters: { total: number; byType: Record<string, number> };
  weakSpots: { total: number; recurring: number };
  aiCalls: AiCallsSummary;
  subscriptions: SubscriptionsSummary;
  usageThisMonth: { byFeature: Record<string, number> };
  pendingActions: { byStatus: Record<string, number> };
};

// ---- human and JSON rendering (pure) ----------------------------------------

const money = (value: number): string => `S$${value.toFixed(2)}`;
const usd = (value: number): string => `US$${value.toFixed(2)}`;
const pairs = (record: Record<string, number>): string =>
  Object.entries(record)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k} ${v}`)
    .join(" | ");

export function formatStats(stats: SettleStats): string[] {
  const lines: string[] = [];
  lines.push(`Settle stats (window ${stats.windowDays} days, generated ${stats.generatedAt})`);
  lines.push("");
  lines.push(
    `users: total ${stats.users.total} | new 24h ${stats.users.new24h} | new ${stats.windowDays}d ${stats.users.newWindow} | with an upload ${stats.users.withUploads}`,
  );
  lines.push(
    `uploads: total ${stats.uploads.total} | ${pairs(stats.uploads.byKind)} | ${pairs(stats.uploads.byStatus)}`,
  );
  lines.push(
    `tasks: total ${stats.tasks.total} | ${pairs(stats.tasks.byStatus)} | by origin ${pairs(stats.tasks.byOrigin)}`,
  );
  lines.push(`starters: total ${stats.starters.total} | ${pairs(stats.starters.byType)}`);
  lines.push(
    `weak spots: total ${stats.weakSpots.total} | recurring (${RECURRING_OCCURRENCES}+ occurrences) ${stats.weakSpots.recurring}`,
  );
  lines.push(
    `ai calls: count ${stats.aiCalls.count} | total ${usd(stats.aiCalls.totalCostUsd)} | today (SGT) ${usd(
      stats.aiCalls.todayCostUsd,
    )} | avg per user with calls ${usd(stats.aiCalls.avgCostPerUserUsd)} | failed ${stats.aiCalls.failures} (${stats.aiCalls.failureRate}%)`,
  );
  const purposeLines = Object.entries(stats.aiCalls.byPurpose).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [purpose, bucket] of purposeLines) {
    lines.push(
      `  ${purpose}: count ${bucket.count} | cost ${usd(bucket.costUsd)} | failed ${bucket.failures}`,
    );
  }
  const mrr = stats.subscriptions.mrrEstimate;
  const mrrText =
    mrr == null
      ? "no recurring Stripe subscribers yet"
      : `${money(mrr.lower)} to ${money(mrr.upper)} (ESTIMATE: ${stats.subscriptions.stripeRecurring} recurring Stripe subscribers; the row does not record monthly vs yearly, so this is the yearly and monthly price band)`;
  const starsText =
    stats.subscriptions.starsPerMonth == null
      ? "no Stars price set"
      : `${stats.subscriptions.starsPerMonth} Stars a month (${stats.subscriptions.starsActive} subscribers x the Stars price, no currency conversion)`;
  lines.push(
    `subscriptions active: ${pairs(stats.subscriptions.activeByProvider)} | by plan ${pairs(stats.subscriptions.activeByPlan)} | Stripe recurring ${stats.subscriptions.stripeRecurring} | PayNow one time ${stats.subscriptions.stripePaynow}`,
  );
  lines.push(`estimated monthly recurring revenue: ${mrrText}`);
  lines.push(`Stars: ${starsText}`);
  lines.push(`usage this month: ${pairs(stats.usageThisMonth.byFeature)}`);
  lines.push(`pending actions: ${pairs(stats.pendingActions.byStatus)}`);
  return lines;
}

export function statsToJson(stats: SettleStats): string {
  return JSON.stringify(stats, null, 2);
}

// ---- I/O helpers (thin, select only) ----------------------------------------

export type StatsFilter =
  | { column: string; op: "eq" | "gte"; value: string }
  | { column: string; op: "in"; value: string[] };

// Filters must be applied before order and range, or PostgREST (and any
// chainable fake) rejects them on an already-awaited query.
function applyFilters<Q extends { eq(c: string, v: string): Q; gte(c: string, v: string): Q; in(c: string, v: string[]): Q }>(
  query: Q,
  filters: StatsFilter[],
): Q {
  let out = query;
  for (const filter of filters) {
    if (filter.op === "in") out = out.in(filter.column, filter.value);
    else if (filter.op === "gte") out = out.gte(filter.column, filter.value);
    else out = out.eq(filter.column, filter.value);
  }
  return out;
}

async function countWhere(
  client: Client,
  table: string,
  filters: StatsFilter[],
): Promise<number> {
  const base = client.from(table).select("id", { count: "exact", head: true });
  const { count, error } = await applyFilters(base, filters);
  if (error) throw new Error(`stats count on ${table} failed: ${error.message}`);
  return count ?? 0;
}

async function fetchAll<T>(
  client: Client,
  table: string,
  columns: string,
  order: string,
  filters: StatsFilter[],
): Promise<T[]> {
  const rows: T[] = [];
  let offset = 0;
  for (;;) {
    const base = client.from(table).select(columns);
    const query = applyFilters(base, filters).order(order).range(offset, offset + PAGE_SIZE - 1);
    const { data, error } = await query;
    if (error) throw new Error(`stats fetch on ${table} failed: ${error.message}`);
    const page = (data ?? []) as T[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
    offset += PAGE_SIZE;
  }
}

// ---- collection (the only code that touches the database) -------------------

export async function collectStats(
  client: Client,
  args: { days: number; now: Date },
): Promise<SettleStats> {
  const now = args.now;
  const iso = (d: Date): string => d.toISOString();
  const since24h = iso(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const sinceWindow = iso(new Date(now.getTime() - args.days * 24 * 60 * 60 * 1000));
  const monthStartIso = iso(periodStartSgt(now));

  const usersTotal = await countWhere(client, "users", []);
  const usersNew24h = await countWhere(client, "users", [{ column: "created_at", op: "gte", value: since24h }]);
  const usersNewWindow = await countWhere(client, "users", [
    { column: "created_at", op: "gte", value: sinceWindow },
  ]);

  // Only kind, status and user_id are read: the upload text itself is
  // never selected, so nothing student written can reach the terminal.
  const uploads = await fetchAll<UploadLite>(client, "uploads", "kind,status,user_id", "created_at", []);

  const tasksTotal = await countWhere(client, "tasks", []);
  const taskStatuses = ["open", "done", "dismissed"];
  const taskOrigins = ["capture", "weak_spot"];
  const byTaskStatus: Record<string, number> = {};
  for (const status of taskStatuses) {
    byTaskStatus[status] = await countWhere(client, "tasks", [{ column: "status", op: "eq", value: status }]);
  }
  const byTaskOrigin: Record<string, number> = {};
  for (const origin of taskOrigins) {
    byTaskOrigin[origin] = await countWhere(client, "tasks", [{ column: "origin", op: "eq", value: origin }]);
  }

  const starterTypes = ["checklist", "flashcards", "math_diagnosis", "review_practice"];
  const startersByType: Record<string, number> = {};
  let startersTotal = 0;
  for (const type of starterTypes) {
    const n = await countWhere(client, "starters", [{ column: "type", op: "eq", value: type }]);
    startersByType[type] = n;
    startersTotal += n;
  }

  const weakSpotsTotal = await countWhere(client, "weak_spots", []);
  const weakSpotsRecurring = await countWhere(client, "weak_spots", [
    { column: "occurrences", op: "gte", value: String(RECURRING_OCCURRENCES) },
  ]);

  const aiCalls = await fetchAll<AiCallLite>(
    client,
    "ai_calls",
    "user_id,purpose,cost_usd,ok,created_at",
    "created_at",
    [],
  );

  const activeSubs = await fetchAll<SubscriptionLite>(
    client,
    "subscriptions",
    "provider,plan,provider_ref",
    "created_at",
    [
      { column: "status", op: "eq", value: "active" },
    ],
  );

  const features = ["chat_capture", "math_diagnosis", "slides_flashcards", "brief_checklist", "weak_spot_tracker"];
  const usageByFeature: Record<string, number> = {};
  for (const feature of features) {
    usageByFeature[feature] = await countWhere(client, "usage_events", [
      { column: "feature", op: "eq", value: feature },
      { column: "created_at", op: "gte", value: monthStartIso },
      { column: "status", op: "in", value: ["claimed", "consumed"] },
    ]);
  }

  const pendingStatuses = ["pending", "accepted", "dismissed"];
  const pendingByStatus: Record<string, number> = {};
  for (const status of pendingStatuses) {
    pendingByStatus[status] = await countWhere(client, "pending_actions", [
      { column: "status", op: "eq", value: status },
    ]);
  }

  return {
    generatedAt: now.toISOString(),
    windowDays: args.days,
    users: {
      total: usersTotal,
      new24h: usersNew24h,
      newWindow: usersNewWindow,
      withUploads: countDistinct(uploads.map((row) => row.user_id)),
    },
    uploads: {
      total: uploads.length,
      byKind: countBy(uploads, (row) => row.kind),
      byStatus: countBy(uploads, (row) => row.status),
    },
    tasks: { total: tasksTotal, byStatus: byTaskStatus, byOrigin: byTaskOrigin },
    starters: { total: startersTotal, byType: startersByType },
    weakSpots: { total: weakSpotsTotal, recurring: weakSpotsRecurring },
    aiCalls: summarizeAiCalls(aiCalls, now),
    subscriptions: summarizeSubscriptions(activeSubs),
    usageThisMonth: { byFeature: usageByFeature },
    pendingActions: { byStatus: pendingByStatus },
  };
}

// Start of the current month in Asia/Singapore, same rule as
// lib/billing/entitlements.periodStart. Duplicated here on purpose: that
// module imports the database layer, and this script must stay import light.
function periodStartSgt(now: Date): Date {
  const shifted = new Date(now.getTime() + SGT_OFFSET_MS);
  const firstOfMonth = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1);
  return new Date(firstOfMonth - SGT_OFFSET_MS);
}

async function main(): Promise<number> {
  let args: StatsArgs;
  try {
    args = parseStatsArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  getEnv(); // fail fast with the normal env validation message
  const client = getSupabase();
  const stats = await collectStats(client, { days: args.days, now: new Date() });
  if (args.json) {
    console.log(statsToJson(stats));
  } else {
    for (const line of formatStats(stats)) console.log(line);
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}

