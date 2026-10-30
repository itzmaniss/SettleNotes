import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "./client";
import type { StarterRow, TaskEventRow, TaskRow, TaskStatus, WeakSpotRow } from "./types";

const DASHBOARD_TASK_LIMIT = 200;
// Tasks finished within this window stay on the dashboard as ticked rows.
const RECENT_DONE_DAYS = 7;

type DbError = { message: string; code?: string; details?: string | null; hint?: string | null };

function throwDb(op: string, error: DbError): never {
  const suffix = error.code ? ` [${error.code}]` : "";
  throw new Error(`db ${op} failed${suffix}: ${error.message}`);
}

export type StudyDeck = { task: TaskRow; starter: StarterRow };

// Dashboard reads, all scoped to the session user. Same factory pattern as
// lib/db/queries.ts so tests can inject a fake client.
export function createDashboardQueries(client: SupabaseClient) {
  // Ownership gate shared by every task-scoped read: BOTH ids must match.
  async function getTaskRowForUser(userId: string, taskId: string): Promise<TaskRow | null> {
    const { data, error } = await client
      .from("tasks")
      .select()
      .eq("id", taskId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throwDb("getTaskForUser", error);
    return (data as TaskRow | null) ?? null;
  }

  return {
    // Open tasks plus tasks ticked off in the last week, so the list still
    // shows recent wins without growing forever.
    async listDashboardTasks(userId: string): Promise<TaskRow[]> {
      const sinceIso = new Date(Date.now() - RECENT_DONE_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const { data, error } = await client
        .from("tasks")
        .select()
        .eq("user_id", userId)
        .or(`status.eq.open,and(status.eq.done,updated_at.gte.${sinceIso})`)
        .order("due_at", { ascending: true, nullsFirst: false })
        .limit(DASHBOARD_TASK_LIMIT);
      if (error) throwDb("listDashboardTasks", error);
      return (data ?? []) as TaskRow[];
    },

    async getTaskForUser(userId: string, taskId: string): Promise<TaskRow | null> {
      return getTaskRowForUser(userId, taskId);
    },

    async listTaskEvents(userId: string, taskId: string): Promise<TaskEventRow[]> {
      const task = await getTaskRowForUser(userId, taskId);
      if (task == null) throw new Error(`task ${taskId} not found for this user`);
      const { data, error } = await client
        .from("task_events")
        .select()
        .eq("task_id", taskId)
        .order("created_at", { ascending: false });
      if (error) throwDb("listTaskEvents", error);
      return (data ?? []) as TaskEventRow[];
    },

    // Newest event per task. Task ids the user does not own are dropped via
    // the ownership filter, so a guessed id yields nothing.
    async listLatestEventsForTasks(userId: string, taskIds: string[]): Promise<TaskEventRow[]> {
      if (taskIds.length === 0) return [];
      const { data: owned, error: ownedError } = await client
        .from("tasks")
        .select("id")
        .eq("user_id", userId)
        .in("id", taskIds);
      if (ownedError) throwDb("listLatestEventsForTasks(tasks)", ownedError);
      const ownedIds = ((owned ?? []) as Array<{ id: string }>).map((row) => row.id);
      if (ownedIds.length === 0) return [];
      const { data, error } = await client
        .from("task_events")
        .select()
        .in("task_id", ownedIds)
        .order("created_at", { ascending: false });
      if (error) throwDb("listLatestEventsForTasks", error);
      const seen = new Set<string>();
      const latest: TaskEventRow[] = [];
      for (const row of (data ?? []) as TaskEventRow[]) {
        if (seen.has(row.task_id)) continue;
        seen.add(row.task_id);
        latest.push(row);
      }
      return latest;
    },

    async getStarterForTask(userId: string, taskId: string): Promise<StarterRow | null> {
      const task = await getTaskRowForUser(userId, taskId);
      if (task == null) return null;
      const { data, error } = await client
        .from("starters")
        .select()
        .eq("task_id", taskId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throwDb("getStarterForTask", error);
      return (data as StarterRow | null) ?? null;
    },

    // Flashcard decks for Quick study: latest flashcards starter per open or
    // recently finished task. Caller decides display order.
    async listStudyDecks(userId: string): Promise<StudyDeck[]> {
      const tasks = await this.listDashboardTasks(userId);
      if (tasks.length === 0) return [];
      const { data, error } = await client
        .from("starters")
        .select()
        .eq("type", "flashcards")
        .in("task_id", tasks.map((task) => task.id))
        .order("created_at", { ascending: false });
      if (error) throwDb("listStudyDecks", error);
      const latestByTask = new Map<string, StarterRow>();
      for (const row of (data ?? []) as StarterRow[]) {
        if (!latestByTask.has(row.task_id)) latestByTask.set(row.task_id, row);
      }
      const decks: StudyDeck[] = [];
      for (const task of tasks) {
        const starter = latestByTask.get(task.id);
        if (starter != null) decks.push({ task, starter });
      }
      return decks;
    },

    async listWeakSpotsForUser(userId: string): Promise<WeakSpotRow[]> {
      const { data, error } = await client
        .from("weak_spots")
        .select()
        .eq("user_id", userId)
        .order("occurrences", { ascending: false })
        .order("last_seen_at", { ascending: false });
      if (error) throwDb("listWeakSpotsForUser", error);
      return (data ?? []) as WeakSpotRow[];
    },

    async updateStarterContent(
      userId: string,
      taskId: string,
      starterId: string,
      content: unknown,
    ): Promise<void> {
      const task = await getTaskRowForUser(userId, taskId);
      if (task == null) throw new Error(`task ${taskId} not found for this user`);
      const { data, error } = await client
        .from("starters")
        .update({ content })
        .eq("id", starterId)
        .eq("task_id", taskId)
        .select("id")
        .maybeSingle();
      if (error) throwDb("updateStarterContent", error);
      if (data == null) throw new Error(`starter ${starterId} not found for this task`);
    },

    async setTaskStatusForUser(userId: string, taskId: string, status: TaskStatus): Promise<TaskRow> {
      const { data, error } = await client
        .from("tasks")
        .update({ status, updated_at: new Date().toISOString() })
        .eq("id", taskId)
        .eq("user_id", userId)
        .select()
        .single();
      if (error != null) {
        // single() fails with PGRST116 when nothing matched, i.e. the task is
        // missing or belongs to someone else. Say that plainly.
        if (error.code === "PGRST116") throw new Error(`task ${taskId} not found for this user`);
        throwDb("setTaskStatusForUser", error);
      }
      return data as TaskRow;
    },
  };
}

export type DashboardQueries = ReturnType<typeof createDashboardQueries>;

// Top-level helpers bound to the shared service-role client, resolved at call
// time so importing this module never touches the environment.
export function listDashboardTasks(userId: string): Promise<TaskRow[]> {
  return createDashboardQueries(getSupabase()).listDashboardTasks(userId);
}

export function getTaskForUser(userId: string, taskId: string): Promise<TaskRow | null> {
  return createDashboardQueries(getSupabase()).getTaskForUser(userId, taskId);
}

export function listTaskEvents(userId: string, taskId: string): Promise<TaskEventRow[]> {
  return createDashboardQueries(getSupabase()).listTaskEvents(userId, taskId);
}

export function listLatestEventsForTasks(userId: string, taskIds: string[]): Promise<TaskEventRow[]> {
  return createDashboardQueries(getSupabase()).listLatestEventsForTasks(userId, taskIds);
}

export function getStarterForTask(userId: string, taskId: string): Promise<StarterRow | null> {
  return createDashboardQueries(getSupabase()).getStarterForTask(userId, taskId);
}

export function listStudyDecks(userId: string): Promise<StudyDeck[]> {
  return createDashboardQueries(getSupabase()).listStudyDecks(userId);
}

export function listWeakSpotsForUser(userId: string): Promise<WeakSpotRow[]> {
  return createDashboardQueries(getSupabase()).listWeakSpotsForUser(userId);
}

export function updateStarterContent(
  userId: string,
  taskId: string,
  starterId: string,
  content: unknown,
): Promise<void> {
  return createDashboardQueries(getSupabase()).updateStarterContent(userId, taskId, starterId, content);
}

export function setTaskStatusForUser(userId: string, taskId: string, status: TaskStatus): Promise<TaskRow> {
  return createDashboardQueries(getSupabase()).setTaskStatusForUser(userId, taskId, status);
}
