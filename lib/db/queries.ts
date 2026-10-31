import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "./client";
import type {
  StarterRow,
  StarterType,
  TaskEffort,
  TaskEventAction,
  TaskKind,
  TaskOrigin,
  TaskRow,
  TaskStatus,
  UploadKind,
  UploadRow,
  UserRow,
  WeakSpotRow,
} from "./types";

export type UpsertUserInput = {
  telegramUserId: number;
  telegramChatId: number;
  firstName: string | null;
  // Optional on purpose: an upsert WITHOUT these must never clear an existing
  // acceptance, so they are only written when provided.
  termsAcceptedAt?: Date;
  termsVersion?: string;
};

export type CreateUploadInput = {
  userId: string;
  kind: UploadKind;
  telegramFileId?: string | null;
  mimeType?: string | null;
  storagePath?: string | null;
  textContent?: string | null;
};

export type FinishUploadPatch = {
  status: "done" | "failed";
  error?: string | null;
  classifiedAs?: string | null;
  textContent?: string | null;
  storagePath?: string | null;
};

export type InsertTaskInput = {
  userId: string;
  title: string;
  course?: string | null;
  kind: TaskKind;
  dueAt?: string | null;
  effort?: TaskEffort | null;
  origin?: TaskOrigin;
  sourceUploadId?: string | null;
  weakSpotId?: string | null;
};

export type UpdateTaskPatch = {
  title?: string;
  course?: string | null;
  kind?: TaskKind;
  dueAt?: string | null;
  effort?: TaskEffort | null;
  status?: TaskStatus;
};

export type InsertTaskEventInput = {
  taskId: string;
  uploadId?: string | null;
  action: TaskEventAction;
  before?: unknown;
  after?: unknown;
  evidence?: string | null;
};

export type InsertStarterInput = {
  taskId: string;
  type: StarterType;
  content: unknown;
  annotatedImagePath?: string | null;
};

export type UpsertWeakSpotInput = {
  userId: string;
  topic: string;
  misconception: string;
  now: Date;
  nextReviewAt: Date | null;
};

export type CreateLoginTokenInput = {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
};

export type LogAiCallInput = {
  userId?: string | null;
  purpose: string;
  model: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedTokens?: number | null;
  audioSeconds?: number | null;
  costUsd?: number | null;
  latencyMs?: number | null;
  ok: boolean;
};

function throwDb(op: string, error: PostgrestError): never {
  const suffix = error.code ? ` [${error.code}]` : "";
  throw new Error(`db ${op} failed${suffix}: ${error.message}`);
}

// SGT is UTC+8 all year, so SGT midnight is 16:00 UTC the previous day.
function startOfSgtDayUtc(now: Date): Date {
  const shifted = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const midnightSgt = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate()
  );
  return new Date(midnightSgt - 8 * 60 * 60 * 1000);
}

// All queries live behind this factory so tests can inject a fake client.
export function createQueries(client: SupabaseClient) {
  return {
    async upsertUser(i: UpsertUserInput): Promise<UserRow> {
      const row: Record<string, unknown> = {
        telegram_user_id: i.telegramUserId,
        telegram_chat_id: i.telegramChatId,
        first_name: i.firstName,
      };
      // Terms columns are written only when provided, so a plain upsert from
      // any existing handler keeps the acceptance that is already stored.
      if (i.termsAcceptedAt !== undefined) row.terms_accepted_at = i.termsAcceptedAt.toISOString();
      if (i.termsVersion !== undefined) row.terms_version = i.termsVersion;
      const { data, error } = await client
        .from("users")
        .upsert(row, { onConflict: "telegram_user_id" })
        .select()
        .single();
      if (error) throwDb("upsertUser", error);
      return data as UserRow;
    },

    // Used by the acceptance gate: the session JWT carries only the user id,
    // so requireSessionUser and the /accept action resolve it to a row first.
    async getUserById(id: string): Promise<UserRow | null> {
      const { data, error } = await client
        .from("users")
        .select()
        .eq("id", id)
        .maybeSingle();
      if (error) throwDb("getUserById", error);
      return (data as UserRow | null) ?? null;
    },

    async markUpdateSeen(updateId: number): Promise<boolean> {
      const { error } = await client.from("telegram_updates").insert({ update_id: updateId });
      if (error) {
        // Duplicate PK = Telegram retry of an already-handled update.
        if (error.code === "23505") return false;
        throwDb("markUpdateSeen", error);
      }
      return true;
    },

    async createUpload(i: CreateUploadInput): Promise<UploadRow> {
      const { data, error } = await client
        .from("uploads")
        .insert({
          user_id: i.userId,
          kind: i.kind,
          telegram_file_id: i.telegramFileId ?? null,
          mime_type: i.mimeType ?? null,
          storage_path: i.storagePath ?? null,
          text_content: i.textContent ?? null,
        })
        .select()
        .single();
      if (error) throwDb("createUpload", error);
      return data as UploadRow;
    },

    async finishUpload(id: string, patch: FinishUploadPatch): Promise<void> {
      const row: Record<string, unknown> = { status: patch.status };
      if (patch.error !== undefined) row.error = patch.error;
      if (patch.classifiedAs !== undefined) row.classified_as = patch.classifiedAs;
      if (patch.textContent !== undefined) row.text_content = patch.textContent;
      if (patch.storagePath !== undefined) row.storage_path = patch.storagePath;
      const { error } = await client.from("uploads").update(row).eq("id", id);
      if (error) throwDb("finishUpload", error);
    },

    async listOpenTasks(userId: string): Promise<TaskRow[]> {
      const { data, error } = await client
        .from("tasks")
        .select()
        .eq("user_id", userId)
        .eq("status", "open")
        .order("due_at", { ascending: true, nullsFirst: false });
      if (error) throwDb("listOpenTasks", error);
      return (data ?? []) as TaskRow[];
    },

    async insertTask(i: InsertTaskInput): Promise<TaskRow> {
      const { data, error } = await client
        .from("tasks")
        .insert({
          user_id: i.userId,
          title: i.title,
          course: i.course ?? null,
          kind: i.kind,
          due_at: i.dueAt ?? null,
          effort: i.effort ?? null,
          origin: i.origin ?? "capture",
          source_upload_id: i.sourceUploadId ?? null,
          weak_spot_id: i.weakSpotId ?? null,
        })
        .select()
        .single();
      if (error) throwDb("insertTask", error);
      return data as TaskRow;
    },

    // Ownership: always filters by BOTH id and user_id.
    async updateTask(id: string, userId: string, patch: UpdateTaskPatch): Promise<TaskRow> {
      const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (patch.title !== undefined) row.title = patch.title;
      if (patch.course !== undefined) row.course = patch.course;
      if (patch.kind !== undefined) row.kind = patch.kind;
      if (patch.dueAt !== undefined) row.due_at = patch.dueAt;
      if (patch.effort !== undefined) row.effort = patch.effort;
      if (patch.status !== undefined) row.status = patch.status;
      const { data, error } = await client
        .from("tasks")
        .update(row)
        .eq("id", id)
        .eq("user_id", userId)
        .select()
        .single();
      if (error) throwDb("updateTask", error);
      return data as TaskRow;
    },

    async insertTaskEvent(i: InsertTaskEventInput): Promise<void> {
      const { error } = await client.from("task_events").insert({
        task_id: i.taskId,
        upload_id: i.uploadId ?? null,
        action: i.action,
        before: i.before ?? null,
        after: i.after ?? null,
        evidence: i.evidence ?? null,
      });
      if (error) throwDb("insertTaskEvent", error);
    },

    async insertStarter(i: InsertStarterInput): Promise<StarterRow> {
      const { data, error } = await client
        .from("starters")
        .insert({
          task_id: i.taskId,
          type: i.type,
          content: i.content,
          annotated_image_path: i.annotatedImagePath ?? null,
        })
        .select()
        .single();
      if (error) throwDb("insertStarter", error);
      return data as StarterRow;
    },

    async getStarter(taskId: string): Promise<StarterRow | null> {
      const { data, error } = await client
        .from("starters")
        .select()
        .eq("task_id", taskId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throwDb("getStarter", error);
      return (data as StarterRow | null) ?? null;
    },

    // PostgREST cannot increment server-side without an RPC, so this is
    // select-then-write with a single retry when a concurrent insert wins the
    // unique(user_id, topic) race.
    async upsertWeakSpot(i: UpsertWeakSpotInput): Promise<WeakSpotRow> {
      const nowIso = i.now.toISOString();
      const nextIso = i.nextReviewAt ? i.nextReviewAt.toISOString() : null;

      const selectExisting = async (): Promise<WeakSpotRow | null> => {
        const { data, error } = await client
          .from("weak_spots")
          .select()
          .eq("user_id", i.userId)
          .eq("topic", i.topic)
          .maybeSingle();
        if (error) throwDb("upsertWeakSpot(select)", error);
        return (data as WeakSpotRow | null) ?? null;
      };

      const bump = async (existing: WeakSpotRow): Promise<WeakSpotRow> => {
        const { data, error } = await client
          .from("weak_spots")
          .update({
            latest_misconception: i.misconception,
            occurrences: existing.occurrences + 1,
            last_seen_at: nowIso,
            next_review_at: nextIso,
          })
          .eq("id", existing.id)
          .select()
          .single();
        if (error) throwDb("upsertWeakSpot(update)", error);
        return data as WeakSpotRow;
      };

      const insertNew = async (): Promise<WeakSpotRow | null> => {
        const { data, error } = await client
          .from("weak_spots")
          .upsert(
            {
              user_id: i.userId,
              topic: i.topic,
              latest_misconception: i.misconception,
              occurrences: 1,
              last_seen_at: nowIso,
              next_review_at: nextIso,
            },
            { onConflict: "user_id,topic" }
          )
          .select()
          .single();
        if (!error) return data as WeakSpotRow;
        if (error.code !== "23505") throwDb("upsertWeakSpot(insert)", error);
        return null;
      };

      const existing = await selectExisting();
      if (existing) return bump(existing);
      const inserted = await insertNew();
      if (inserted) return inserted;
      const raced = await selectExisting();
      if (!raced) {
        throw new Error("db upsertWeakSpot failed: insert raced but no existing row was found");
      }
      return bump(raced);
    },

    async createLoginToken(i: CreateLoginTokenInput): Promise<void> {
      const { error } = await client.from("login_tokens").insert({
        token_hash: i.tokenHash,
        user_id: i.userId,
        expires_at: i.expiresAt.toISOString(),
      });
      if (error) throwDb("createLoginToken", error);
    },

    // Single use: the UPDATE only matches unexpired, unconsumed tokens and
    // PostgREST returns the updated row, making consume atomic.
    async consumeLoginToken(tokenHash: string, now: Date): Promise<{ userId: string } | null> {
      const nowIso = now.toISOString();
      const { data, error } = await client
        .from("login_tokens")
        .update({ used_at: nowIso })
        .eq("token_hash", tokenHash)
        .is("used_at", null)
        .gt("expires_at", nowIso)
        .select("user_id")
        .maybeSingle();
      if (error) throwDb("consumeLoginToken", error);
      const row = data as { user_id: string } | null;
      return row ? { userId: row.user_id } : null;
    },

    async logAiCall(i: LogAiCallInput): Promise<void> {
      const { error } = await client.from("ai_calls").insert({
        user_id: i.userId ?? null,
        purpose: i.purpose,
        model: i.model,
        input_tokens: i.inputTokens ?? null,
        output_tokens: i.outputTokens ?? null,
        cached_tokens: i.cachedTokens ?? null,
        audio_seconds: i.audioSeconds ?? null,
        cost_usd: i.costUsd ?? null,
        latency_ms: i.latencyMs ?? null,
        ok: i.ok,
      });
      if (error) throwDb("logAiCall", error);
    },

    async todaysAiSpend(now: Date = new Date()): Promise<number> {
      const { data, error } = await client
        .from("ai_calls")
        .select("cost_usd")
        .gte("created_at", startOfSgtDayUtc(now).toISOString());
      if (error) throwDb("todaysAiSpend", error);
      const rows = (data ?? []) as { cost_usd: number | string | null }[];
      let sum = 0;
      for (const row of rows) {
        sum += row.cost_usd == null ? 0 : Number(row.cost_usd);
      }
      return sum;
    },

    async countUploadsLastHour(userId: string, now: Date = new Date()): Promise<number> {
      const since = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
      const { count, error } = await client
        .from("uploads")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .gte("created_at", since);
      if (error) throwDb("countUploadsLastHour", error);
      return count ?? 0;
    },
  };
}

export type Queries = ReturnType<typeof createQueries>;

// Top-level helpers bound to the shared service-role client, resolved at call
// time so importing this module never touches the environment.
export function upsertUser(i: UpsertUserInput): Promise<UserRow> {
  return createQueries(getSupabase()).upsertUser(i);
}

export function getUserById(id: string): Promise<UserRow | null> {
  return createQueries(getSupabase()).getUserById(id);
}

export function markUpdateSeen(updateId: number): Promise<boolean> {
  return createQueries(getSupabase()).markUpdateSeen(updateId);
}

export function createUpload(i: CreateUploadInput): Promise<UploadRow> {
  return createQueries(getSupabase()).createUpload(i);
}

export function finishUpload(id: string, patch: FinishUploadPatch): Promise<void> {
  return createQueries(getSupabase()).finishUpload(id, patch);
}

export function listOpenTasks(userId: string): Promise<TaskRow[]> {
  return createQueries(getSupabase()).listOpenTasks(userId);
}

export function insertTask(i: InsertTaskInput): Promise<TaskRow> {
  return createQueries(getSupabase()).insertTask(i);
}

export function updateTask(id: string, userId: string, patch: UpdateTaskPatch): Promise<TaskRow> {
  return createQueries(getSupabase()).updateTask(id, userId, patch);
}

export function insertTaskEvent(i: InsertTaskEventInput): Promise<void> {
  return createQueries(getSupabase()).insertTaskEvent(i);
}

export function insertStarter(i: InsertStarterInput): Promise<StarterRow> {
  return createQueries(getSupabase()).insertStarter(i);
}

export function getStarter(taskId: string): Promise<StarterRow | null> {
  return createQueries(getSupabase()).getStarter(taskId);
}

export function upsertWeakSpot(i: UpsertWeakSpotInput): Promise<WeakSpotRow> {
  return createQueries(getSupabase()).upsertWeakSpot(i);
}

export function createLoginToken(i: CreateLoginTokenInput): Promise<void> {
  return createQueries(getSupabase()).createLoginToken(i);
}

export function consumeLoginToken(
  tokenHash: string,
  now: Date
): Promise<{ userId: string } | null> {
  return createQueries(getSupabase()).consumeLoginToken(tokenHash, now);
}

export function logAiCall(i: LogAiCallInput): Promise<void> {
  return createQueries(getSupabase()).logAiCall(i);
}

export function todaysAiSpend(now?: Date): Promise<number> {
  return createQueries(getSupabase()).todaysAiSpend(now);
}

export function countUploadsLastHour(userId: string, now?: Date): Promise<number> {
  return createQueries(getSupabase()).countUploadsLastHour(userId, now);
}
