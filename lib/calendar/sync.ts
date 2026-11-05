import { buildEvent, CALENDAR_NAME, eventHash, isSyncable, type CalendarTask } from "./event";
import { GoogleError, type GoogleCalendarClient } from "./google";
import type { CalendarQueries } from "./queries";

export type PlanTask = CalendarTask & { id: string };

export type PlanLink = {
  task_id: string;
  google_event_id: string;
  synced_hash: string;
};

export type PlanPatch = {
  task: PlanTask;
  link: PlanLink;
};

export type SyncPlan = {
  create: PlanTask[];
  patch: PlanPatch[];
  remove: PlanLink[];
};

export type SyncSummary = {
  created: number;
  patched: number;
  removed: number;
  failed: number;
};

export const SYNC_LOCK_TTL_MS = 2 * 60 * 1000;

export type SyncUserCalendarDeps = {
  queries: Pick<
    CalendarQueries,
    | "getConnection"
    | "upsertConnection"
    | "setConnectionStatus"
    | "listLinks"
    | "upsertLink"
    | "deleteLink"
    | "claimSyncLock"
    | "releaseSyncLock"
  >;
  listOpenTasks: (userId: string) => Promise<PlanTask[]>;
  google: GoogleCalendarClient;
  decrypt: (blob: string, key: string) => string;
  tokenKey: string;
  now?: () => Date;
};

// Pure diff of open tasks against stored links. Create covers syncable tasks
// with no link, patch covers links whose event body changed, remove covers
// links whose task is gone or no longer syncable. Equal hashes are a no-op,
// so applying a plan then planning again yields empty lists.
export function planSync(tasks: PlanTask[], links: PlanLink[]): SyncPlan {
  const plan: SyncPlan = { create: [], patch: [], remove: [] };
  const linkByTask = new Map(links.map((link) => [link.task_id, link]));
  const taskById = new Map(tasks.map((task) => [task.id, task]));

  for (const task of tasks) {
    if (!isSyncable(task)) continue;
    const link = linkByTask.get(task.id);
    if (!link) {
      plan.create.push(task);
    } else if (eventHash(buildEvent(task)) !== link.synced_hash) {
      plan.patch.push({ task, link });
    }
  }

  for (const link of links) {
    const task = taskById.get(link.task_id);
    if (!task || !isSyncable(task)) plan.remove.push(link);
  }

  return plan;
}

// Reconciles Google with the task list. Auth failures mark the connection
// needs_reconnect and stop; rate and server errors stop quietly so the next
// run retries; one missing event reads as already deleted; a single task
// failure counts as failed and never aborts the rest.
export async function syncUserCalendar(
  userId: string,
  deps: SyncUserCalendarDeps
): Promise<SyncSummary> {
  const summary: SyncSummary = { created: 0, patched: 0, removed: 0, failed: 0 };
  const now = deps.now ?? (() => new Date());

  const stopFor = async (err: unknown): Promise<boolean> => {
    if (err instanceof GoogleError && err.kind === "auth") {
      await deps.queries.setConnectionStatus(userId, "needs_reconnect");
      return true;
    }
    if (err instanceof GoogleError && (err.kind === "rate" || err.kind === "server")) return true;
    return false;
  };

  const connection = await deps.queries.getConnection(userId);
  if (!connection || connection.status !== "active") return summary;
  if (!connection.refresh_token_enc) return summary;

  const locked = await deps.queries.claimSyncLock(userId, now(), SYNC_LOCK_TTL_MS);
  if (!locked) return summary;

  try {
    let accessToken: string;
    try {
      const refreshToken = deps.decrypt(connection.refresh_token_enc, deps.tokenKey);
      accessToken = (await deps.google.refreshAccessToken(refreshToken)).accessToken;
    } catch (err) {
      if (await stopFor(err)) return summary;
      throw err;
    }

    let calendarId = connection.google_calendar_id;
    try {
      const exists = calendarId ? await deps.google.getCalendarExists(accessToken, calendarId) : false;
      if (!exists) {
        calendarId = (await deps.google.createCalendar(accessToken, CALENDAR_NAME)).id;
        await deps.queries.upsertConnection({
          userId,
          googleCalendarId: calendarId,
          refreshTokenEnc: connection.refresh_token_enc,
          status: "active",
        });
      }
    } catch (err) {
      if (await stopFor(err)) return summary;
      throw err;
    }
    if (!calendarId) return summary;

    const tasks = await deps.listOpenTasks(userId);
    const links = await deps.queries.listLinks(userId);
    const plan = planSync(tasks, links);

    for (const task of plan.create) {
      try {
        const event = buildEvent(task);
        const { id } = await deps.google.insertEvent(accessToken, calendarId, event);
        await deps.queries.upsertLink({
          taskId: task.id,
          userId,
          googleEventId: id,
          syncedHash: eventHash(event),
          syncedAt: now(),
        });
        summary.created += 1;
      } catch (err) {
        if (await stopFor(err)) return summary;
        summary.failed += 1;
      }
    }

    for (const { task, link } of plan.patch) {
      try {
        const event = buildEvent(task);
        let eventId = link.google_event_id;
        try {
          await deps.google.patchEvent(accessToken, calendarId, eventId, event);
        } catch (err) {
          if (err instanceof GoogleError && err.kind === "gone") {
            eventId = (await deps.google.insertEvent(accessToken, calendarId, event)).id;
          } else {
            throw err;
          }
        }
        await deps.queries.upsertLink({
          taskId: task.id,
          userId,
          googleEventId: eventId,
          syncedHash: eventHash(event),
          syncedAt: now(),
        });
        summary.patched += 1;
      } catch (err) {
        if (await stopFor(err)) return summary;
        summary.failed += 1;
      }
    }

    for (const link of plan.remove) {
      try {
        try {
          await deps.google.deleteEvent(accessToken, calendarId, link.google_event_id);
        } catch (err) {
          if (!(err instanceof GoogleError) || err.kind !== "gone") throw err;
        }
        await deps.queries.deleteLink(link.task_id);
        summary.removed += 1;
      } catch (err) {
        if (await stopFor(err)) return summary;
        summary.failed += 1;
      }
    }

    return summary;
  } finally {
    await deps.queries.releaseSyncLock(userId);
  }
}
