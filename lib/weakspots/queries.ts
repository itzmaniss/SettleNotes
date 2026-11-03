import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "@/lib/db/client";
import type { TaskRow, WeakSpotRow } from "@/lib/db/types";

type DbError = { message: string; code?: string; details?: string | null; hint?: string | null };

function throwDb(op: string, error: DbError): never {
  const suffix = error.code ? ` [${error.code}]` : "";
  throw new Error(`db ${op} failed${suffix}: ${error.message}`);
}

// Weak-spot reads and writes that lib/db/queries.ts does not already carry
// (that file is frozen for this card). Same factory pattern so tests can
// inject a fake client.
export function createWeakSpotQueries(client: SupabaseClient) {
  return {
    // Ownership: filters by BOTH ids, like every other row-scoped write.
    async getWeakSpot(userId: string, weakSpotId: string): Promise<WeakSpotRow | null> {
      const { data, error } = await client
        .from("weak_spots")
        .select()
        .eq("id", weakSpotId)
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throwDb("getWeakSpot", error);
      return (data as WeakSpotRow | null) ?? null;
    },

    async setWeakSpotNextReview(
      userId: string,
      weakSpotId: string,
      nextReviewAt: Date | null
    ): Promise<WeakSpotRow> {
      const { data, error } = await client
        .from("weak_spots")
        .update({ next_review_at: nextReviewAt == null ? null : nextReviewAt.toISOString() })
        .eq("id", weakSpotId)
        .eq("user_id", userId)
        .select()
        .single();
      if (error) throwDb("setWeakSpotNextReview", error);
      return data as WeakSpotRow;
    },

    // Newest open review task for one weak spot, or null when none exists.
    async findOpenReviewTask(userId: string, weakSpotId: string): Promise<TaskRow | null> {
      const { data, error } = await client
        .from("tasks")
        .select()
        .eq("user_id", userId)
        .eq("weak_spot_id", weakSpotId)
        .eq("kind", "review")
        .eq("status", "open")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throwDb("findOpenReviewTask", error);
      return (data as TaskRow | null) ?? null;
    },

    // Open review tasks for the weak-spots page. weak_spot_id is kept on the
    // rows so the page can match each task back to its topic.
    async listOpenReviewTasksByWeakSpot(
      userId: string,
      weakSpotIds: string[]
    ): Promise<TaskRow[]> {
      if (weakSpotIds.length === 0) return [];
      const { data, error } = await client
        .from("tasks")
        .select()
        .eq("user_id", userId)
        .in("weak_spot_id", weakSpotIds)
        .eq("kind", "review")
        .eq("status", "open")
        .order("created_at", { ascending: false });
      if (error) throwDb("listOpenReviewTasksByWeakSpot", error);
      return (data ?? []) as TaskRow[];
    },
  };
}

export type WeakSpotQueries = ReturnType<typeof createWeakSpotQueries>;

// Top-level helpers bound to the shared service-role client, resolved at call
// time so importing this module never touches the environment.
export function getWeakSpotById(userId: string, weakSpotId: string): Promise<WeakSpotRow | null> {
  return createWeakSpotQueries(getSupabase()).getWeakSpot(userId, weakSpotId);
}

export function setWeakSpotNextReview(
  userId: string,
  weakSpotId: string,
  nextReviewAt: Date | null
): Promise<WeakSpotRow> {
  return createWeakSpotQueries(getSupabase()).setWeakSpotNextReview(userId, weakSpotId, nextReviewAt);
}

export function findOpenReviewTask(userId: string, weakSpotId: string): Promise<TaskRow | null> {
  return createWeakSpotQueries(getSupabase()).findOpenReviewTask(userId, weakSpotId);
}

export function listOpenReviewTasksByWeakSpot(
  userId: string,
  weakSpotIds: string[]
): Promise<TaskRow[]> {
  return createWeakSpotQueries(getSupabase()).listOpenReviewTasksByWeakSpot(userId, weakSpotIds);
}
