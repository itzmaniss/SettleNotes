import type { SupabaseClient } from "@supabase/supabase-js";

// Hand rolled fake of the pieces of the Supabase client the privacy library
// uses: a chainable, thenable PostgREST builder over in-memory tables that
// actually applies eq/in/like/filter (including payload->> json paths and the
// dotted tasks.user_id embed filter), plus a storage API with folders,
// pagination and remove. Every operation is recorded so tests can assert
// ordering, read only guarantees and per query user filters.

export type Row = Record<string, unknown>;

export type RecordedFilter = { column: string; op: string; value: unknown };

export type RecordedOp =
  | { kind: "select"; table: string; columns: string; head: boolean; filters: RecordedFilter[] }
  | { kind: "update"; table: string; payload: Row; filters: RecordedFilter[] }
  | { kind: "delete"; table: string; filters: RecordedFilter[] }
  | { kind: "insert"; table: string; payload: unknown }
  | { kind: "storage.list"; bucket: string; path: string; limit?: number; offset?: number }
  | { kind: "storage.remove"; bucket: string; paths: string[] };

// Which child table joins to which parent for the dotted filter, and on which
// foreign key column.
const EMBED_RELATIONS: Record<string, Record<string, string>> = {
  task_events: { tasks: "task_id" },
  starters: { tasks: "task_id" },
};

export type FakeOptions = {
  objects?: string[];
  // Page size the fake storage list returns at most, even when the caller
  // asks for more (models a backend with a hard max page size).
  pageSize?: number;
  // The Nth (1 based) storage remove call returns an error instead of deleting.
  removeFailAtCall?: number;
  // The users row delete does not cascade (verification leftover test).
  noCascade?: boolean;
  // Storage list always returns a full page of files (file guard test).
  infiniteList?: boolean;
  // Storage list always returns one folder entry, whatever the path (page
  // guard test: the walk recurses forever without collecting files).
  infiniteFolders?: boolean;
};

// PostgREST returns exactly the requested columns; mimic that so projections
// are under test too. Embeds like tasks!inner(user_id) add no column here.
function project(row: Row, columns: string): Row {
  if (columns === "*" || columns.trim() === "*" || columns.trim() === "") return { ...row };
  const names = columns
    .split(",")
    .map((c) => c.trim())
    .filter((c) => c.length > 0 && !c.includes("!") && !c.includes("("));
  const out: Row = {};
  for (const name of names) {
    if (name in row) out[name] = row[name];
  }
  return out;
}

function matches(row: Row, table: string, filters: RecordedFilter[], data: Record<string, Row[]>): boolean {
  return filters.every((f) => {
    if (f.column.startsWith("payload->>")) {
      const key = f.column.slice("payload->>".length);
      const payload = row.payload;
      const actual =
        payload != null && typeof payload === "object" ? (payload as Row)[key] : undefined;
      if (f.op === "eq") return String(actual) === String(f.value);
      if (f.op === "like") {
        const pattern = String(f.value);
        const suffix = pattern.startsWith("*") ? pattern.slice(1) : pattern;
        return typeof actual === "string" && actual.endsWith(suffix);
      }
      return false;
    }
    const dot = f.column.indexOf(".");
    if (dot >= 0) {
      const parent = f.column.slice(0, dot);
      const field = f.column.slice(dot + 1);
      const fk = EMBED_RELATIONS[table]?.[parent];
      if (fk === undefined) return false;
      const parentRow = (data[parent] ?? []).find((p) => p.id === row[fk]);
      if (parentRow === undefined) return false;
      return parentRow[field] === f.value;
    }
    if (f.op === "eq") return row[f.column] === f.value;
    if (f.op === "in") return (f.value as unknown[]).includes(row[f.column]);
    if (f.op === "like") return String(row[f.column]).includes(String(f.value).replace(/\*/g, ""));
    return false;
  });
}

export type FakeDb = {
  client: SupabaseClient;
  ops: RecordedOp[];
  data: Record<string, Row[]>;
  removedBatches: string[][];
  storageObjects: () => string[];
  setStorageObjects: (objects: string[]) => void;
};

export function makeFakeDb(tables: Record<string, Row[]>, opts: FakeOptions = {}): FakeDb {
  const data: Record<string, Row[]> = Object.fromEntries(
    Object.entries(tables).map(([table, rows]) => [table, rows.map((row) => ({ ...row }))]),
  );
  const ops: RecordedOp[] = [];
  const removedBatches: string[][] = [];
  let storageObjects = [...(opts.objects ?? [])];
  let removeCalls = 0;

  function cascadeDeleteUser(userId: string): void {
    if (opts.noCascade === true) return;
    const removedUploadIds = new Set(
      (data.uploads ?? []).filter((r) => r.user_id === userId).map((r) => r.id),
    );
    const taskIds = new Set((data.tasks ?? []).filter((r) => r.user_id === userId).map((r) => r.id));
    data.task_events = (data.task_events ?? []).filter((r) => !taskIds.has(r.task_id));
    data.starters = (data.starters ?? []).filter((r) => !taskIds.has(r.task_id));
    data.tasks = (data.tasks ?? []).filter((r) => r.user_id !== userId);
    data.uploads = (data.uploads ?? []).filter((r) => r.user_id !== userId);
    data.weak_spots = (data.weak_spots ?? []).filter((r) => r.user_id !== userId);
    data.subscriptions = (data.subscriptions ?? []).filter((r) => r.user_id !== userId);
    data.usage_events = (data.usage_events ?? []).filter((r) => r.user_id !== userId);
    data.pending_actions = (data.pending_actions ?? []).filter((r) => r.user_id !== userId);
    data.login_tokens = (data.login_tokens ?? []).filter((r) => r.user_id !== userId);
    for (const row of data.ai_calls ?? []) {
      if (row.user_id === userId) row.user_id = null;
    }
    // Other users' rows that pointed at the deleted uploads keep going, with
    // the reference set to null (on delete set null).
    for (const table of ["task_events", "usage_events", "pending_actions", "tasks"]) {
      for (const row of data[table] ?? []) {
        if (row.upload_id !== undefined && removedUploadIds.has(row.upload_id)) row.upload_id = null;
        if (table === "tasks") {
          if (row.source_upload_id !== undefined && removedUploadIds.has(row.source_upload_id)) {
            row.source_upload_id = null;
          }
        }
      }
    }
    data.users = (data.users ?? []).filter((r) => r.id !== userId);
  }

  function execute(
    table: string,
    state: { method: string; head: boolean; payload: unknown; limit: number | null; columns: string },
    filters: RecordedFilter[],
    offset: number,
    end: number,
    mode: "list" | "maybeSingle" | "single",
  ): { data: unknown; error: { message: string; code?: string } | null; count: number } {
    const pool = data[table] ?? [];
    if (state.method === "select") {
      ops.push({ kind: "select", table, columns: state.columns ?? "*", head: state.head, filters: [...filters] });
      const rows = pool.filter((row) => matches(row, table, filters, data));
      if (state.head) return { data: null, error: null, count: rows.length };
      let out = rows;
      if (mode === "list") out = rows.slice(offset, end + 1);
      if (state.limit != null) out = out.slice(0, state.limit);
      const projected = out.map((row) => project(row, state.columns));
      if (mode === "single" && projected.length === 0) {
        return { data: null, error: { message: "fake: no rows", code: "PGRST116" }, count: 0 };
      }
      if (mode !== "list") {
        return { data: projected[0] === undefined ? null : projected[0], error: null, count: projected.length };
      }
      return { data: projected, error: null, count: rows.length };
    }
    if (state.method === "update") {
      ops.push({ kind: "update", table, payload: state.payload as Row, filters: [...filters] });
      const matched = pool.filter((row) => matches(row, table, filters, data));
      for (const row of matched) Object.assign(row, state.payload as Row);
      return { data: matched[0] === undefined ? null : { ...matched[0] }, error: null, count: matched.length };
    }
    if (state.method === "delete") {
      ops.push({ kind: "delete", table, filters: [...filters] });
      const matched = pool.filter((row) => matches(row, table, filters, data));
      if (table === "users") {
        for (const row of matched) cascadeDeleteUser(row.id as string);
      } else {
        const keep = new Set(matched.map((row) => JSON.stringify(row)));
        data[table] = pool.filter((row) => !keep.has(JSON.stringify(row)));
      }
      return { data: null, error: null, count: matched.length };
    }
    if (state.method === "insert") {
      ops.push({ kind: "insert", table, payload: state.payload });
      const rows = Array.isArray(state.payload) ? state.payload : [state.payload];
      data[table] = [...pool, ...(rows as Row[]).map((row) => ({ ...(row as Row) }))];
      return { data: null, error: null, count: rows.length };
    }
    return { data: null, error: { message: `fake: unsupported method ${state.method}` }, count: 0 };
  }

  function build(table: string) {
    const filters: RecordedFilter[] = [];
    const state = {
      method: "select",
      head: false,
      payload: undefined as unknown,
      limit: null as number | null,
      columns: "*" as string,
    };
    const builder = {
      select(columns?: string, o?: { head?: boolean; count?: string }) {
        state.columns = columns ?? "*";
        if (o?.head === true || typeof o?.count === "string") state.head = true;
        return builder;
      },
      eq(column: string, value: unknown) {
        filters.push({ column, op: "eq", value });
        return builder;
      },
      in(column: string, value: unknown[]) {
        filters.push({ column, op: "in", value });
        return builder;
      },
      like(column: string, value: string) {
        filters.push({ column, op: "like", value });
        return builder;
      },
      filter(column: string, operator: string, value: unknown) {
        filters.push({ column, op: operator, value });
        return builder;
      },
      order() {
        return builder;
      },
      limit(n: number) {
        state.limit = n;
        return builder;
      },
      range(offset: number, end: number) {
        return Promise.resolve(execute(table, state, filters, offset, end, "list"));
      },
      maybeSingle() {
        return Promise.resolve(execute(table, state, filters, 0, 0, "maybeSingle"));
      },
      single() {
        return Promise.resolve(execute(table, state, filters, 0, 0, "single"));
      },
      update(payload: unknown) {
        state.method = "update";
        state.payload = payload;
        return builder;
      },
      delete() {
        state.method = "delete";
        return builder;
      },
      insert(payload: unknown) {
        state.method = "insert";
        state.payload = payload;
        return builder;
      },
      upsert(payload: unknown) {
        state.method = "insert";
        state.payload = payload;
        return builder;
      },
      then<TResult1 = { data: unknown; error: unknown; count: number }, TResult2 = never>(
        onFulfilled?: (value: { data: unknown; error: unknown; count: number }) => TResult1,
        onRejected?: (reason: unknown) => TResult2,
      ) {
        return Promise.resolve(execute(table, state, filters, 0, Number.MAX_SAFE_INTEGER, "list")).then(
          onFulfilled,
          onRejected,
        );
      },
    };
    return builder;
  }

  const storage = {
    from(bucket: string) {
      return {
        async list(path = "", options?: { limit?: number; offset?: number }) {
          ops.push({
            kind: "storage.list",
            bucket,
            path,
            limit: options?.limit,
            offset: options?.offset,
          });
          const requested = options?.limit ?? opts.pageSize ?? 1000;
          const limit = opts.pageSize !== undefined ? Math.min(requested, opts.pageSize) : requested;
          const offset = options?.offset ?? 0;
          if (opts.infiniteFolders === true) {
            return { data: [{ name: "loop", id: null }], error: null };
          }
          if (opts.infiniteList === true) {
            return {
              data: Array.from({ length: limit }, (_, i) => ({
                name: `obj-${offset}-${i}`,
                id: `id-${offset}-${i}`,
              })),
              error: null,
            };
          }
          const prefix = path === "" ? "" : path.endsWith("/") ? path : `${path}/`;
          const entries = new Map<string, { name: string; id: string | null }>();
          for (const obj of storageObjects) {
            if (!obj.startsWith(prefix)) continue;
            const rest = obj.slice(prefix.length);
            if (rest.length === 0) continue;
            const slash = rest.indexOf("/");
            if (slash === -1) {
              entries.set(rest, { name: rest, id: `id:${obj}` });
            } else {
              const folder = rest.slice(0, slash);
              const existing = entries.get(folder);
              if (existing === undefined || existing.id !== null) {
                entries.set(folder, { name: folder, id: null });
              }
            }
          }
          const all = [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
          return { data: all.slice(offset, offset + limit), error: null };
        },
        async remove(paths: string[]) {
          removeCalls += 1;
          removedBatches.push([...paths]);
          ops.push({ kind: "storage.remove", bucket, paths: [...paths] });
          if (opts.removeFailAtCall !== undefined && removeCalls === opts.removeFailAtCall) {
            return { data: null, error: { message: "fake storage remove failure" } };
          }
          const dead = new Set(paths);
          storageObjects = storageObjects.filter((o) => !dead.has(o));
          return { data: paths.map((p) => ({ name: p })), error: null };
        },
      };
    },
  };

  const client = { from: build, storage } as unknown as SupabaseClient;
  return {
    client,
    ops,
    data,
    removedBatches,
    storageObjects: () => [...storageObjects],
    setStorageObjects: (objects: string[]) => {
      storageObjects = [...objects];
    },
  };
}
