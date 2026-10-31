import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { makeFakeDb, type Row } from "./fake-supabase";
import {
  BASE_OBJECTS,
  NAME_A,
  NAME_B,
  TELEGRAM_A,
  TELEGRAM_B,
  USER_A,
  USER_B,
  baseTables,
} from "./fixtures";
import {
  DEFAULT_STALE_DAYS,
  DAY_MS,
  daysInactive,
  findStaleAccounts,
  formatStaleSweep,
  hasLiveSubscription,
  isStale,
  latestActivityMs,
  parseStaleArgs,
} from "../../lib/privacy/stale";

const NOW = new Date("2026-10-31T00:00:00.000Z");
const NOW_MS = NOW.getTime();

function user(id: string, telegramUserId: number, createdAt: string): Row {
  return { id, telegram_user_id: telegramUserId, created_at: createdAt };
}

function upload(id: string, userId: string, createdAt: string): Row {
  return { id, user_id: userId, created_at: createdAt };
}

// 2026-10-31 minus N days, as an ISO string (no leap day in between).
function daysAgoIso(days: number): string {
  return new Date(NOW_MS - days * DAY_MS).toISOString();
}

describe("parseStaleArgs", () => {
  test("defaults to 365 days and accepts a custom threshold", () => {
    expect(parseStaleArgs([])).toEqual({ ok: true, days: DEFAULT_STALE_DAYS });
    expect(DEFAULT_STALE_DAYS).toBe(365);
    expect(parseStaleArgs(["--days", "90"])).toEqual({ ok: true, days: 90 });
  });

  test("refuses invalid thresholds and unknown arguments", () => {
    for (const argv of [
      ["--days"],
      ["--days", "0"],
      ["--days", "-1"],
      ["--days", "abc"],
      ["--days", "1.5"],
      ["--days", "99999999999999999999"],
      ["--yes"],
      ["--days", "90", "--force"],
    ]) {
      const parsed = parseStaleArgs(argv);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.usage).toMatch(/Usage: bun run scripts\/stale-accounts\.ts/);
    }
  });
});

describe("pure activity and staleness helpers", () => {
  test("latestActivityMs takes the newest of the account and its three feeds", () => {
    const latest = latestActivityMs(
      { created_at: "2026-01-01T00:00:00.000Z" },
      {
        uploads: ["2026-03-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z"],
        taskEvents: ["2026-05-01T00:00:00.000Z"],
        usageEvents: [],
      },
    );
    expect(latest).toBe(Date.parse("2026-05-01T00:00:00.000Z"));
  });

  test("latestActivityMs with no activity at all falls back to the account row", () => {
    const created = "2025-12-01T00:00:00.000Z";
    expect(latestActivityMs({ created_at: created }, { uploads: [], taskEvents: [], usageEvents: [] })).toBe(
      Date.parse(created),
    );
  });

  test("the threshold boundary: exactly N days counts as stale, a day less does not", () => {
    const last = Date.parse("2025-10-31T00:00:00.000Z");
    expect(isStale(last, NOW_MS, 365)).toBe(true);
    expect(isStale(last + DAY_MS, NOW_MS, 365)).toBe(false);
    expect(daysInactive(last, NOW_MS)).toBe(365);
    expect(daysInactive(NOW_MS, NOW_MS)).toBe(0);
  });

  test("hasLiveSubscription follows the same rule as the erase blockers", () => {
    const base = { provider: "stripe", provider_ref: "sub_1", plan: "pro" };
    expect(hasLiveSubscription([{ ...base, status: "active", current_period_end: "2027-06-01T00:00:00.000Z" }], NOW)).toBe(true);
    expect(hasLiveSubscription([{ ...base, status: "active", current_period_end: "2026-01-01T00:00:00.000Z" }], NOW)).toBe(false);
    expect(hasLiveSubscription([{ ...base, status: "active", current_period_end: null }], NOW)).toBe(false);
    expect(hasLiveSubscription([{ ...base, status: "canceled", current_period_end: "2027-06-01T00:00:00.000Z" }], NOW)).toBe(false);
    expect(
      hasLiveSubscription(
        [{ provider: "stripe", provider_ref: "paynow:cs_1", plan: "pro", status: "active", current_period_end: "2027-06-01T00:00:00.000Z" }],
        NOW,
      ),
    ).toBe(true);
    expect(hasLiveSubscription([], NOW)).toBe(false);
  });
});

describe("findStaleAccounts on the fake database", () => {
  test("an account active yesterday is excluded; just under and just over the threshold split", async () => {
    const fresh = "99999999-0000-4000-8000-000000000001";
    const under = "99999999-0000-4000-8000-000000000002";
    const over = "99999999-0000-4000-8000-000000000003";
    const fake = makeFakeDb({
      users: [
        user(fresh, 1110001, daysAgoIso(400)),
        user(under, 1110002, daysAgoIso(400)),
        user(over, 1110003, daysAgoIso(400)),
      ],
      uploads: [
        upload("aaaa0000-0000-4000-8000-00000000000a", fresh, daysAgoIso(1)),
        upload("aaaa0000-0000-4000-8000-00000000000b", under, daysAgoIso(364)),
        upload("aaaa0000-0000-4000-8000-00000000000c", over, daysAgoIso(366)),
      ],
    });
    const result = await findStaleAccounts(fake.client, { days: 365, now: NOW });
    expect(result.checked).toBe(3);
    expect(result.accounts.map((a) => a.user.id)).toEqual([over]);
    expect(result.accounts[0]!.inactiveDays).toBe(366);
    const mutating = fake.ops.filter(
      (op) => op.kind === "update" || op.kind === "delete" || op.kind === "insert" || op.kind === "storage.remove",
    );
    expect(mutating).toEqual([]);
  });

  test("an active subscription excludes the account even when it is idle; a PayNow period that has ended does not", async () => {
    const idleStripe = "88888888-0000-4000-8000-000000000001";
    const idlePaynow = "88888888-0000-4000-8000-000000000002";
    const tables: Record<string, Row[]> = {
      users: [
        user(idleStripe, 2220001, daysAgoIso(400)),
        user(idlePaynow, 2220002, daysAgoIso(400)),
      ],
      uploads: [
        upload("aaaa0000-0000-4000-8000-00000000000d", idleStripe, daysAgoIso(400)),
        upload("aaaa0000-0000-4000-8000-00000000000e", idlePaynow, daysAgoIso(400)),
      ],
      subscriptions: [
        {
          id: "77770000-0000-4000-8000-00000000000a",
          user_id: idleStripe,
          provider: "stripe",
          provider_ref: "sub_live_1",
          plan: "pro",
          status: "active",
          current_period_end: "2027-06-01T00:00:00.000Z",
        },
        {
          id: "77770000-0000-4000-8000-00000000000b",
          user_id: idlePaynow,
          provider: "stripe",
          provider_ref: "paynow:cs_done",
          plan: "pro",
          status: "active",
          current_period_end: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    const fake = makeFakeDb(tables);
    const live = await findStaleAccounts(fake.client, { days: 365, now: NOW });
    expect(live.accounts.map((a) => a.user.id)).toEqual([idlePaynow]);

    // The same world one period later: both accounts are on the list.
    const later = new Date("2027-07-01T00:00:00.000Z");
    const after = await findStaleAccounts(fake.client, { days: 365, now: later });
    expect(after.accounts.map((a) => a.user.id).sort()).toEqual([idlePaynow, idleStripe].sort());
  });

  test("another user's activity never counts for someone else", async () => {
    const taskA = "cccc0000-0000-4000-8000-000000000001";
    const taskB = "cccc0000-0000-4000-8000-000000000002";
    const fake = makeFakeDb({
      users: [user(USER_A, TELEGRAM_A, daysAgoIso(400)), user(USER_B, TELEGRAM_B, daysAgoIso(400))],
      tasks: [
        { id: taskA, user_id: USER_A, created_at: daysAgoIso(400) },
        { id: taskB, user_id: USER_B, created_at: daysAgoIso(400) },
      ],
      task_events: [
        // A's task got a fresh event; B's stayed old.
        { id: "eeee0000-0000-4000-8000-000000000001", task_id: taskA, created_at: daysAgoIso(2) },
        { id: "eeee0000-0000-4000-8000-000000000002", task_id: taskB, created_at: daysAgoIso(399) },
      ],
    });
    const result = await findStaleAccounts(fake.client, { days: 365, now: NOW });
    expect(result.accounts.map((a) => a.user.id)).toEqual([USER_B]);
    expect(result.accounts[0]!.inactiveDays).toBe(399);
  });
});

describe("sweep output", () => {
  test("shows short ids, telegram ids, counts and the exact next command, and never names", async () => {
    const fake = makeFakeDb(baseTables(), { objects: BASE_OBJECTS });
    // A year and a month on, both fixture subscriptions have run out.
    const result = await findStaleAccounts(fake.client, { days: 365, now: new Date("2027-11-30T00:00:00.000Z") });
    expect(result.checked).toBe(2);
    const lines = formatStaleSweep(result);
    const text = lines.join("\n");
    expect(text).toContain("Stale account sweep");
    expect(text).toContain("user 11111111");
    expect(text).toContain("telegram id 5500112233");
    expect(text).toContain("bun run scripts/delete-user.ts --telegram-id 5500112233");
    expect(text).toContain("user 22222222");
    expect(text).toContain("bun run scripts/delete-user.ts --telegram-id 6600223344");
    expect(text).toContain("Summary: 2 stale accounts of 2 checked (threshold 365 days).");
    expect(text).toContain("This sweep only reads. Nothing was changed.");
    // The full uuid, the names and any content never appear; and the kind of
    // dash that is banned everywhere is absent too.
    expect(text).not.toContain(USER_A);
    expect(text).not.toContain(USER_B);
    expect(text).not.toContain(NAME_A);
    expect(text).not.toContain(NAME_B);
    expect(text).not.toMatch(/[\u2013\u2014]/);
    // Sorted oldest activity first.
    expect(result.accounts[0]!.user.id).toBe(USER_A);
    console.log(`[sample stale-accounts output]\n${text}`);
  });

  test("an empty world prints a clean nothing to do summary", async () => {
    const fake = makeFakeDb({ users: [] });
    const result = await findStaleAccounts(fake.client, { days: 365, now: NOW });
    const text = formatStaleSweep(result).join("\n");
    expect(text).toContain("Checked 0 accounts; 0 look stale.");
    expect(text).toContain("Summary: 0 stale accounts of 0 checked (threshold 365 days).");
  });
});

// The read only guarantee, enforced on the source: no write call may appear in
// the sweep script or its library.
describe("read only source scan for the sweep", () => {
  const sources = [
    readFileSync(new URL("../../scripts/stale-accounts.ts", import.meta.url), "utf8"),
    readFileSync(new URL("../../lib/privacy/stale.ts", import.meta.url), "utf8"),
  ];

  test("no insert, update, delete, upsert, rpc or storage remove call anywhere", () => {
    for (const source of sources) {
      for (const method of ["insert", "update", "delete", "upsert", "rpc", "remove"]) {
        expect(source).not.toContain(`.${method}(`);
      }
    }
  });

  test("the sweep script only imports the read only modules", () => {
    const script = sources[0]!;
    expect(script).not.toContain("eraseUser");
    expect(script).not.toContain("removeStoredFiles");
    const imports = [...script.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    for (const target of imports) {
      expect([
        "@supabase/supabase-js",
        "../lib/db/client",
        "../lib/env",
        "../lib/privacy/stale",
      ]).toContain(target);
    }
  });
});
