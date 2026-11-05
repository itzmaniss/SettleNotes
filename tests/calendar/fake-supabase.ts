import type { SupabaseClient } from "@supabase/supabase-js";

export type FakeError = { message: string; code?: string };
export type FakeReply = { data?: unknown; error?: FakeError | null };

export type RecordedCall = {
  table: string;
  method: "select" | "insert" | "update" | "upsert" | "delete";
  payload: unknown;
  upsertOptions: Record<string, unknown> | undefined;
  selectColumns: string | undefined;
  limitCount: number | undefined;
  filters: { op: string; column: string; value: unknown }[];
};

// Minimal chainable stand-in for the PostgREST builder: records every call
// and resolves through the test-provided replyFor.
export function makeFakeClient(replyFor: (call: RecordedCall) => FakeReply): SupabaseClient {
  function build(table: string) {
    const call: RecordedCall = {
      table,
      method: "select",
      payload: undefined,
      upsertOptions: undefined,
      selectColumns: undefined,
      limitCount: undefined,
      filters: [],
    };

    const respond = (allowEmpty: boolean): Promise<{ data: unknown; error: unknown }> => {
      const reply = replyFor(call);
      if (reply.error) return Promise.resolve({ data: null, error: reply.error });
      if (!allowEmpty && reply.data == null) {
        return Promise.resolve({
          data: null,
          error: { message: `fake: no single row for ${table} ${call.method}`, code: "PGRST116" },
        });
      }
      return Promise.resolve({ data: reply.data ?? null, error: null });
    };

    const builder = {
      insert(payload: unknown) {
        call.method = "insert";
        call.payload = payload;
        return builder;
      },
      update(payload: unknown) {
        call.method = "update";
        call.payload = payload;
        return builder;
      },
      upsert(payload: unknown, options?: Record<string, unknown>) {
        call.method = "upsert";
        call.payload = payload;
        call.upsertOptions = options;
        return builder;
      },
      delete() {
        call.method = "delete";
        return builder;
      },
      select(columns?: string) {
        call.selectColumns = columns;
        return builder;
      },
      eq(column: string, value: unknown) {
        call.filters.push({ op: "eq", column, value });
        return builder;
      },
      or(value: string) {
        call.filters.push({ op: "or", column: "or", value });
        return builder;
      },
      limit(n: number) {
        call.limitCount = n;
        return builder;
      },
      single() {
        return respond(false);
      },
      maybeSingle() {
        return respond(true);
      },
      then(onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
        return respond(true).then(onFulfilled, onRejected);
      },
    };
    return builder;
  }

  return { from: build } as unknown as SupabaseClient;
}
