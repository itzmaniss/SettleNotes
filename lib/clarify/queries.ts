// Supabase access for pending_actions, in the same style as lib/db/queries.ts
// (factory over an injected client, lazy real wrappers at the bottom) but in
// its own file: the clarify feature owns its row type and queries so
// lib/db/queries.ts stays untouched. Every read and write is scoped by
// user_id, matching the ownership rule in docs/ARCHITECTURE.md section 5.
import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "@/lib/db/client";
import type { TaskRow, UserRow } from "@/lib/db/types";
import type { PendingActionInput, PendingActionRow } from "./types";

function throwDb(op: string, error: PostgrestError): never {
  const suffix = error.code ? ` [${error.code}]` : "";
  throw new Error(`db ${op} failed${suffix}: ${error.message}`);
}

export type ClaimStatus = "accepted" | "dismissed";

export function createPendingActionsQueries(client: SupabaseClient) {
  return {
    // The tap resolves a Telegram sender to a user row before anything is
    // read, so it lives with the other scoped queries.
    async getUserByTelegramId(telegramUserId: number): Promise<UserRow | null> {
      const { data, error } = await client
        .from("users")
        .select()
        .eq("telegram_user_id", telegramUserId)
        .maybeSingle();
      if (error) throwDb("getUserByTelegramId", error);
      return (data as UserRow | null) ?? null;
    },

    async insertPendingAction(i: PendingActionInput): Promise<PendingActionRow> {
      const { data, error } = await client
        .from("pending_actions")
        .insert({
          user_id: i.userId,
          upload_id: i.uploadId ?? null,
          kind: i.kind,
          task_id: i.taskId,
          payload: i.payload,
        })
        .select()
        .single();
      if (error) throwDb("insertPendingAction", error);
      return data as PendingActionRow;
    },

    // Scoped read so the tap handler can tell "expired" apart from "missing,
    // foreign or already handled" before the atomic claim.
    async getPendingAction(id: string, userId: string): Promise<PendingActionRow | null> {
      const { data, error } = await client
        .from("pending_actions")
        .select()
        .eq("id", id)
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throwDb("getPendingAction", error);
      return (data as PendingActionRow | null) ?? null;
    },

    // Single use: the UPDATE only matches this user's still-pending,
    // unexpired row and PostgREST returns the claimed row, so a double tap or
    // a race applies at most once. Null means someone got there first.
    async claimPendingAction(
      id: string,
      userId: string,
      status: ClaimStatus,
      now: Date,
    ): Promise<PendingActionRow | null> {
      const nowIso = now.toISOString();
      const { data, error } = await client
        .from("pending_actions")
        .update({ status, resolved_at: nowIso })
        .eq("id", id)
        .eq("user_id", userId)
        .eq("status", "pending")
        .gt("expires_at", nowIso)
        .select()
        .maybeSingle();
      if (error) throwDb("claimPendingAction", error);
      return (data as PendingActionRow | null) ?? null;
    },

    // A failed apply hands the row back so the student can tap again.
    async resetPendingAction(id: string, userId: string): Promise<void> {
      const { error } = await client
        .from("pending_actions")
        .update({ status: "pending", resolved_at: null })
        .eq("id", id)
        .eq("user_id", userId);
      if (error) throwDb("resetPendingAction", error);
    },

    // The tap-time re-check for update/complete: still there, still theirs,
    // still open.
    async getOpenTask(taskId: string, userId: string): Promise<TaskRow | null> {
      const { data, error } = await client
        .from("tasks")
        .select()
        .eq("id", taskId)
        .eq("user_id", userId)
        .eq("status", "open")
        .maybeSingle();
      if (error) throwDb("getOpenTask", error);
      return (data as TaskRow | null) ?? null;
    },
  };
}

export type PendingActionsQueries = ReturnType<typeof createPendingActionsQueries>;

// Top-level helpers bound to the shared service-role client, resolved at call
// time so importing this module never touches the environment.
export function insertPendingAction(i: PendingActionInput): Promise<PendingActionRow> {
  return createPendingActionsQueries(getSupabase()).insertPendingAction(i);
}

export function getPendingAction(id: string, userId: string): Promise<PendingActionRow | null> {
  return createPendingActionsQueries(getSupabase()).getPendingAction(id, userId);
}

export function claimPendingAction(
  id: string,
  userId: string,
  status: ClaimStatus,
  now: Date,
): Promise<PendingActionRow | null> {
  return createPendingActionsQueries(getSupabase()).claimPendingAction(id, userId, status, now);
}

export function resetPendingAction(id: string, userId: string): Promise<void> {
  return createPendingActionsQueries(getSupabase()).resetPendingAction(id, userId);
}

export function getOpenTask(taskId: string, userId: string): Promise<TaskRow | null> {
  return createPendingActionsQueries(getSupabase()).getOpenTask(taskId, userId);
}

export function getUserByTelegramId(telegramUserId: number): Promise<UserRow | null> {
  return createPendingActionsQueries(getSupabase()).getUserByTelegramId(telegramUserId);
}
