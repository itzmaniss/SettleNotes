// Row counts for everything the cascade removes, plus ai_calls which the
// cascade anonymises instead of removing. Counts only: the dry run prints
// these numbers and nothing about the content.
import type { SupabaseClient } from "@supabase/supabase-js";
import { countExact, type PrivacyFilter } from "./query";

export type OwnedCounts = {
  uploads: number;
  tasks: number;
  task_events: number;
  starters: number;
  weak_spots: number;
  subscriptions: number;
  usage_events: number;
  pending_actions: number;
  purchase_confirmations: number;
  login_tokens: number;
  ai_calls: number;
};

// Display and iteration order for the counts.
export const OWNED_TABLES: Array<{ table: keyof OwnedCounts; note?: string }> = [
  { table: "uploads" },
  { table: "tasks" },
  { table: "task_events" },
  { table: "starters" },
  { table: "weak_spots" },
  { table: "subscriptions" },
  { table: "usage_events" },
  { table: "pending_actions" },
  { table: "purchase_confirmations" },
  { table: "login_tokens" },
  { table: "ai_calls", note: "rows kept, anonymised" },
];

// task_events and starters hang off tasks rather than users, so they are
// counted through an inner join on tasks.user_id (a PostgREST embedded
// filter); the database cascade removes them together with the tasks.
export async function countOwnedRows(client: SupabaseClient, userId: string): Promise<OwnedCounts> {
  const eqUser = (column = "user_id"): PrivacyFilter[] => [{ column, op: "eq", value: userId }];
  return {
    uploads: await countExact(client, "uploads", eqUser()),
    tasks: await countExact(client, "tasks", eqUser()),
    task_events: await countExact(
      client,
      "task_events",
      eqUser("tasks.user_id"),
      "id,tasks!inner(user_id)",
    ),
    starters: await countExact(
      client,
      "starters",
      eqUser("tasks.user_id"),
      "id,tasks!inner(user_id)",
    ),
    weak_spots: await countExact(client, "weak_spots", eqUser()),
    subscriptions: await countExact(client, "subscriptions", eqUser()),
    usage_events: await countExact(client, "usage_events", eqUser()),
    pending_actions: await countExact(client, "pending_actions", eqUser()),
    purchase_confirmations: await countExact(client, "purchase_confirmations", eqUser()),
    login_tokens: await countExact(client, "login_tokens", eqUser()),
    ai_calls: await countExact(client, "ai_calls", eqUser()),
  };
}

export function allZero(counts: OwnedCounts): boolean {
  return OWNED_TABLES.every(({ table }) => counts[table] === 0);
}

export function nonzeroEntries(counts: OwnedCounts): Array<[keyof OwnedCounts, number]> {
  return OWNED_TABLES.filter(({ table }) => counts[table] > 0).map(({ table }) => [
    table,
    counts[table],
  ]);
}
