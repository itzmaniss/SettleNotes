// Fire and forget calendar sync after a user-visible task change. Returns
// immediately: when the flag is on and the user holds an active connection
// the sync runs in the background. Never throws, never logs, and touches no
// network otherwise. All deps are injected for tests; production call sites
// pass only the user id and the real pieces resolve lazily inside.
import { isCalendarSyncEnabled } from "./flags";
import type { CalendarConnectionRow } from "./queries";
import type { SyncSummary } from "./sync";

export type TriggerDeps = {
  enabled?: () => boolean;
  getConnection?: (userId: string) => Promise<CalendarConnectionRow | null>;
  runSync?: (userId: string) => Promise<SyncSummary>;
};

export function triggerCalendarSync(userId: string, deps?: TriggerDeps): void {
  let on = false;
  try {
    on = (deps?.enabled ?? isCalendarSyncEnabled)();
  } catch {
    return;
  }
  if (!on) return;
  void (async () => {
    try {
      const getConnection =
        deps?.getConnection ??
        ((id: string) => import("./queries").then((m) => m.getConnection(id)));
      const connection = await getConnection(userId);
      if (connection == null || connection.status !== "active") return;
      if (deps?.runSync) {
        await deps.runSync(userId);
        return;
      }
      const [{ syncUserCalendar }, { buildCalendarSyncDeps }] = await Promise.all([
        import("./sync"),
        import("./runtime"),
      ]);
      await syncUserCalendar(userId, buildCalendarSyncDeps());
    } catch {
      // A background sync must never surface: the next change or cron retries.
    }
  })();
}
