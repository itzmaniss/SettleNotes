import { describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

const { triggerCalendarSync } = await import("../../lib/calendar/trigger");

function activeConnection() {
  return {
    user_id: "user-1",
    google_calendar_id: "cal-1",
    refresh_token_enc: "enc-1",
    status: "active" as const,
    sync_lock_until: null,
    created_at: "",
    updated_at: "",
  };
}

// The sync runs in the background; one macrotask flush is enough for the
// injected fakes to have run.
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("triggerCalendarSync", () => {
  test("does nothing when the feature is off", async () => {
    let synced = 0;
    triggerCalendarSync("user-1", {
      enabled: () => false,
      getConnection: async () => activeConnection(),
      runSync: async () => {
        synced += 1;
        return { created: 0, patched: 0, removed: 0, failed: 0 };
      },
    });
    await flush();
    expect(synced).toBe(0);
  });

  test("returns immediately and syncs in the background", async () => {
    const synced: string[] = [];
    triggerCalendarSync("user-1", {
      enabled: () => true,
      getConnection: async () => activeConnection(),
      runSync: async (userId) => {
        synced.push(userId);
        return { created: 1, patched: 0, removed: 0, failed: 0 };
      },
    });
    await flush();
    expect(synced).toEqual(["user-1"]);
  });

  test("does nothing without an active connection", async () => {
    for (const connection of [null, { ...activeConnection(), status: "needs_reconnect" as const }]) {
      let synced = 0;
      triggerCalendarSync("user-1", {
        enabled: () => true,
        getConnection: async () => connection,
        runSync: async () => {
          synced += 1;
          return { created: 0, patched: 0, removed: 0, failed: 0 };
        },
      });
      await flush();
      expect(synced).toBe(0);
    }
  });

  test("swallows every error and never throws", async () => {
    triggerCalendarSync("user-1", {
      enabled: () => {
        throw new Error("flag down");
      },
    });
    triggerCalendarSync("user-1", {
      enabled: () => true,
      getConnection: async () => {
        throw new Error("db down");
      },
      runSync: async () => {
        throw new Error("unreachable");
      },
    });
    triggerCalendarSync("user-1", {
      enabled: () => true,
      getConnection: async () => activeConnection(),
      runSync: async () => {
        throw new Error("sync down");
      },
    });
    await flush();
  });
});
