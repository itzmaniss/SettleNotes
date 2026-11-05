// Real dependencies for the /api/calendar routes. Built lazily inside the
// route handlers, never at import time, so importing this module touches no
// environment (same split as lib/account/export-route.ts).
import "server-only";
import { getSessionUser } from "@/lib/auth/session";
import { getPlanForUser } from "@/lib/billing/entitlements";
import { getSupabase } from "@/lib/db/client";
import { listOpenTasks } from "@/lib/db/queries";
import { env } from "@/lib/env";
import { decryptToken } from "./crypto";
import { isCalendarSyncEnabled } from "./flags";
import { createGoogleClient } from "./google";
import { createCalendarQueries } from "./queries";
import { syncUserCalendar, type PlanTask, type SyncUserCalendarDeps } from "./sync";
import type { CalendarRouteDeps } from "./handlers";

export function buildCalendarSyncDeps(): SyncUserCalendarDeps {
  const queries = createCalendarQueries(getSupabase());
  const google = createGoogleClient({
    // Present whenever the flag is on; empty strings fail closed at Google.
    clientId: env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: env.GOOGLE_CLIENT_SECRET ?? "",
    fetch: globalThis.fetch,
  });
  const tokenKey = env.CALENDAR_TOKEN_KEY ?? "";
  return {
    queries,
    listOpenTasks: async (userId: string): Promise<PlanTask[]> => {
      const rows = await listOpenTasks(userId);
      return rows.map((row) => ({
        id: row.id,
        title: row.title,
        course: row.course,
        due_at: row.due_at,
        status: row.status,
      }));
    },
    google,
    decrypt: (blob: string) => decryptToken(blob, tokenKey),
    tokenKey,
  };
}

export function realCalendarRouteDeps(): CalendarRouteDeps {
  // One queries object per call, resolved inside the closures, so building
  // the deps never touches the environment (same as the export route).
  const queries = () => createCalendarQueries(getSupabase());
  return {
    enabled: () => isCalendarSyncEnabled(),
    sessionUserId: async () => (await getSessionUser())?.userId ?? null,
    planForUser: (userId: string) => getPlanForUser(userId),
    config: () => ({
      clientId: env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: env.GOOGLE_CLIENT_SECRET ?? "",
      tokenKey: env.CALENDAR_TOKEN_KEY ?? "",
      cronSecret: env.CALENDAR_CRON_SECRET ?? "",
      appBaseUrl: env.APP_BASE_URL,
      sessionSecret: env.SESSION_SECRET,
    }),
    fetchFn: globalThis.fetch,
    queries: {
      getConnection: (userId: string) => queries().getConnection(userId),
      upsertConnection: (input) => queries().upsertConnection(input),
      deleteConnection: (userId: string) => queries().deleteConnection(userId),
      listActiveConnections: (limit: number) => queries().listActiveConnections(limit),
      deleteLinksForUser: (userId: string) => queries().deleteLinksForUser(userId),
    },
    listOpenTasks: async (userId: string): Promise<PlanTask[]> => {
      const rows = await listOpenTasks(userId);
      return rows.map((row) => ({
        id: row.id,
        title: row.title,
        course: row.course,
        due_at: row.due_at,
        status: row.status,
      }));
    },
    runSync: (userId: string) => syncUserCalendar(userId, buildCalendarSyncDeps()),
    now: () => new Date(),
    log: (message: string) => console.log(message),
  };
}
