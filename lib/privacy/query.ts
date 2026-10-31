// Shared PostgREST plumbing for the privacy library: typed filters, a paged
// select and an exact head count. Everything here only reads; the write paths
// live in billing-events.ts (payload updates) and erase.ts (the users row).
import type { SupabaseClient } from "@supabase/supabase-js";

// PostgREST returns at most 1000 rows per request, so multi row fetches page
// with .range() on a stable order until a short page comes back.
export const PAGE_SIZE = 200;

export type PrivacyFilter =
  | { column: string; op: "eq"; value: string }
  | { column: string; op: "in"; value: string[] }
  | { column: string; op: "like"; value: string }
  // Raw PostgREST filter for json paths such as "payload->>user_id", which
  // the typed helpers do not cover.
  | { column: string; op: "filter"; operator: string; value: string };

type Filterable<Q> = {
  eq(column: string, value: string): Q;
  in(column: string, value: string[]): Q;
  like(column: string, value: string): Q;
  filter(column: string, operator: string, value: unknown): Q;
};

// Filters must be applied before order and range, or PostgREST (and any
// chainable fake) rejects them on an already-awaited query.
export function applyFilters<Q extends Filterable<Q>>(query: Q, filters: PrivacyFilter[]): Q {
  let out = query;
  for (const filter of filters) {
    if (filter.op === "in") out = out.in(filter.column, filter.value);
    else if (filter.op === "like") out = out.like(filter.column, filter.value);
    else if (filter.op === "filter") out = out.filter(filter.column, filter.operator, filter.value);
    else out = out.eq(filter.column, filter.value);
  }
  return out;
}

export async function fetchPaged<T>(
  client: SupabaseClient,
  table: string,
  columns: string,
  filters: PrivacyFilter[],
  orderBy?: string,
): Promise<T[]> {
  const rows: T[] = [];
  let offset = 0;
  for (;;) {
    const base = client.from(table).select(columns);
    const filtered = applyFilters(base, filters);
    const ranged =
      orderBy === undefined
        ? filtered.range(offset, offset + PAGE_SIZE - 1)
        : filtered.order(orderBy).range(offset, offset + PAGE_SIZE - 1);
    const { data, error } = await ranged;
    if (error) throw new Error(`privacy fetch on ${table} failed: ${error.message}`);
    const page = (data ?? []) as T[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
    offset += PAGE_SIZE;
  }
}

// Exact count without rows: a head count answers exactly at any table size.
export async function countExact(
  client: SupabaseClient,
  table: string,
  filters: PrivacyFilter[],
  select = "id",
): Promise<number> {
  const base = client.from(table).select(select, { count: "exact", head: true });
  const { count, error } = await applyFilters(base, filters);
  if (error) throw new Error(`privacy count on ${table} failed: ${error.message}`);
  return count ?? 0;
}
