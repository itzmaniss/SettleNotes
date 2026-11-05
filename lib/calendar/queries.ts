import "server-only";
import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "@/lib/db/client";

export type ConnectionStatus = "active" | "needs_reconnect";

export type CalendarConnectionRow = {
  user_id: string;
  google_calendar_id: string | null;
  refresh_token_enc: string | null;
  status: ConnectionStatus;
  sync_lock_until: string | null;
  created_at: string;
  updated_at: string;
};

export type CalendarEventLinkRow = {
  task_id: string;
  user_id: string;
  google_event_id: string;
  synced_hash: string;
  synced_at: string;
};

export type UpsertConnectionInput = {
  userId: string;
  googleCalendarId: string | null;
  refreshTokenEnc: string | null;
  status: ConnectionStatus;
};

export type UpsertLinkInput = {
  taskId: string;
  userId: string;
  googleEventId: string;
  syncedHash: string;
  syncedAt?: Date;
};

function throwCalendar(op: string, error: PostgrestError): never {
  const suffix = error.code ? ` [${error.code}]` : "";
  throw new Error(`calendar ${op} failed${suffix}: ${error.message}`);
}

// All calendar queries live behind this factory so tests can inject a fake
// client, same as lib/billing/queries.ts.
export function createCalendarQueries(client: SupabaseClient) {
  return {
    async getConnection(userId: string): Promise<CalendarConnectionRow | null> {
      const { data, error } = await client
        .from("calendar_connections")
        .select()
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throwCalendar("getConnection", error);
      return (data as CalendarConnectionRow | null) ?? null;
    },

    async upsertConnection(i: UpsertConnectionInput): Promise<CalendarConnectionRow> {
      const { data, error } = await client
        .from("calendar_connections")
        .upsert(
          {
            user_id: i.userId,
            google_calendar_id: i.googleCalendarId,
            refresh_token_enc: i.refreshTokenEnc,
            status: i.status,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id" }
        )
        .select()
        .single();
      if (error) throwCalendar("upsertConnection", error);
      return data as CalendarConnectionRow;
    },

    async setConnectionStatus(userId: string, status: ConnectionStatus): Promise<void> {
      const { error } = await client
        .from("calendar_connections")
        .update({ status, updated_at: new Date().toISOString() })
        .eq("user_id", userId);
      if (error) throwCalendar("setConnectionStatus", error);
    },

    async deleteConnection(userId: string): Promise<void> {
      const { error } = await client.from("calendar_connections").delete().eq("user_id", userId);
      if (error) throwCalendar("deleteConnection", error);
    },

    async listActiveConnections(limit: number): Promise<CalendarConnectionRow[]> {
      const { data, error } = await client
        .from("calendar_connections")
        .select()
        .eq("status", "active")
        .limit(limit);
      if (error) throwCalendar("listActiveConnections", error);
      return (data ?? []) as CalendarConnectionRow[];
    },

    async claimSyncLock(userId: string, now: Date, ttlMs: number): Promise<boolean> {
      const until = new Date(now.getTime() + ttlMs).toISOString();
      const { data, error } = await client
        .from("calendar_connections")
        .update({ sync_lock_until: until, updated_at: now.toISOString() })
        .eq("user_id", userId)
        .or(`sync_lock_until.is.null,sync_lock_until.lte.${now.toISOString()}`)
        .select("user_id");
      if (error) throwCalendar("claimSyncLock", error);
      return Array.isArray(data) ? data.length > 0 : data != null;
    },

    async releaseSyncLock(userId: string): Promise<void> {
      const { error } = await client
        .from("calendar_connections")
        .update({ sync_lock_until: null, updated_at: new Date().toISOString() })
        .eq("user_id", userId);
      if (error) throwCalendar("releaseSyncLock", error);
    },

    async listLinks(userId: string): Promise<CalendarEventLinkRow[]> {
      const { data, error } = await client
        .from("calendar_event_links")
        .select()
        .eq("user_id", userId);
      if (error) throwCalendar("listLinks", error);
      return (data ?? []) as CalendarEventLinkRow[];
    },

    async upsertLink(i: UpsertLinkInput): Promise<CalendarEventLinkRow> {
      const { data, error } = await client
        .from("calendar_event_links")
        .upsert(
          {
            task_id: i.taskId,
            user_id: i.userId,
            google_event_id: i.googleEventId,
            synced_hash: i.syncedHash,
            synced_at: (i.syncedAt ?? new Date()).toISOString(),
          },
          { onConflict: "task_id" }
        )
        .select()
        .single();
      if (error) throwCalendar("upsertLink", error);
      return data as CalendarEventLinkRow;
    },

    async deleteLink(taskId: string): Promise<void> {
      const { error } = await client.from("calendar_event_links").delete().eq("task_id", taskId);
      if (error) throwCalendar("deleteLink", error);
    },

    async deleteLinksForUser(userId: string): Promise<void> {
      const { error } = await client
        .from("calendar_event_links")
        .delete()
        .eq("user_id", userId);
      if (error) throwCalendar("deleteLinksForUser", error);
    },
  };
}

export type CalendarQueries = ReturnType<typeof createCalendarQueries>;

// Top-level helpers bound to the shared service-role client, resolved at call
// time so importing this module never touches the environment.
export function getConnection(userId: string): Promise<CalendarConnectionRow | null> {
  return createCalendarQueries(getSupabase()).getConnection(userId);
}

export function upsertConnection(i: UpsertConnectionInput): Promise<CalendarConnectionRow> {
  return createCalendarQueries(getSupabase()).upsertConnection(i);
}

export function setConnectionStatus(userId: string, status: ConnectionStatus): Promise<void> {
  return createCalendarQueries(getSupabase()).setConnectionStatus(userId, status);
}

export function deleteConnection(userId: string): Promise<void> {
  return createCalendarQueries(getSupabase()).deleteConnection(userId);
}

export function listLinks(userId: string): Promise<CalendarEventLinkRow[]> {
  return createCalendarQueries(getSupabase()).listLinks(userId);
}

export function upsertLink(i: UpsertLinkInput): Promise<CalendarEventLinkRow> {
  return createCalendarQueries(getSupabase()).upsertLink(i);
}

export function deleteLink(taskId: string): Promise<void> {
  return createCalendarQueries(getSupabase()).deleteLink(taskId);
}

export function deleteLinksForUser(userId: string): Promise<void> {
  return createCalendarQueries(getSupabase()).deleteLinksForUser(userId);
}

export function listActiveConnections(limit: number): Promise<CalendarConnectionRow[]> {
  return createCalendarQueries(getSupabase()).listActiveConnections(limit);
}

export function claimSyncLock(userId: string, now: Date, ttlMs: number): Promise<boolean> {
  return createCalendarQueries(getSupabase()).claimSyncLock(userId, now, ttlMs);
}

export function releaseSyncLock(userId: string): Promise<void> {
  return createCalendarQueries(getSupabase()).releaseSyncLock(userId);
}
