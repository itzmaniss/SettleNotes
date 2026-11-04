import { describe, expect, test } from "bun:test";
import { createExportRateLimiter } from "../../lib/account/rate-limit";
import { exportFileStamp, handleAccountExport, type ExportRouteDeps } from "../../lib/account/export-route";
import { EXPORT_RATE_LIMIT_LINE } from "../../lib/account/web-copy";
import type { PrivacyExport } from "../../lib/privacy/export";

// 4 Nov 2026, 09:31 SGT. The file stamp must be Singapore wall clock.
const NOW = new Date("2026-11-04T01:31:00.000Z");
const SESSION_USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";

const sampleExport: PrivacyExport = {
  exported_at: NOW.toISOString(),
  note: "note",
  account: {
    id: SESSION_USER,
    telegram_user_id: 101,
    telegram_chat_id: 101,
    first_name: "Wei",
    timezone: "Asia/Singapore",
    terms_accepted_at: null,
    terms_version: null,
    created_at: NOW.toISOString(),
  },
  uploads: [],
  tasks: [],
  task_events: [],
  starters: [],
  weak_spots: [],
  subscriptions: [],
  usage_events: [],
  pending_actions: [],
  purchase_confirmations: [],
  ai_calls_summary: {
    count: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cost_usd: 0,
    by_purpose: {},
  },
  files: [],
};

function makeDeps(overrides: Partial<ExportRouteDeps> = {}) {
  const calls: { exportFor: string[]; existsFor: string[] } = { exportFor: [], existsFor: [] };
  const deps: ExportRouteDeps = {
    sessionUserId: async () => SESSION_USER,
    userExists: async (userId) => {
      calls.existsFor.push(userId);
      return true;
    },
    build: async (userId) => {
      calls.exportFor.push(userId);
      return sampleExport;
    },
    rateLimit: () => ({ ok: true }),
    now: () => NOW,
    ...overrides,
  };
  return { deps, calls };
}

describe("exportFileStamp", () => {
  test("the file name date is Singapore wall clock", () => {
    // 04:31 UTC on 4 Nov is 12:31 SGT on 4 Nov.
    expect(exportFileStamp(NOW)).toBe("2026-11-04");
    // 17:00 UTC on 3 Nov is 01:00 SGT on 4 Nov.
    expect(exportFileStamp(new Date("2026-11-03T17:00:00.000Z"))).toBe("2026-11-04");
  });
});

describe("handleAccountExport", () => {
  test("without a session it redirects to /login", async () => {
    const { deps, calls } = makeDeps({ sessionUserId: async () => null });
    const res = await handleAccountExport(deps);
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/login");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(calls.exportFor).toEqual([]);
  });

  test("a session whose user row is gone also goes to /login", async () => {
    const { deps, calls } = makeDeps({ userExists: async () => false });
    const res = await handleAccountExport(deps);
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/login");
    expect(calls.exportFor).toEqual([]);
  });

  test("the export is built for the session user only; a query param user id is ignored", async () => {
    const { deps, calls } = makeDeps();
    const res = await handleAccountExport(deps, {
      url: `https://settle.example.com/account/export?user_id=${OTHER_USER}&telegram_id=101`,
    });
    expect(res.status).toBe(200);
    // Only ever the session's user id, never the one from the URL.
    expect(calls.exportFor).toEqual([SESSION_USER]);
    expect(calls.existsFor).toEqual([SESSION_USER]);
    const body = (await res.text()) as string;
    expect(JSON.parse(body)).toEqual(sampleExport);
    expect(JSON.stringify(JSON.parse(body))).not.toContain(OTHER_USER);
  });

  test("the response is a no-store JSON attachment named settle-data-YYYY-MM-DD.json", async () => {
    const { deps } = makeDeps();
    const res = await handleAccountExport(deps);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="settle-data-2026-11-04.json"',
    );
  });

  test("the fourth export inside the window gets a plain sentence and 429", async () => {
    const time = { now: () => NOW };
    const limiter = createExportRateLimiter(3, 10 * 60 * 1000, time.now);
    const rateLimit = (userId: string, at: Date) => limiter(userId, at);
    for (let i = 0; i < 3; i++) {
      const { deps } = makeDeps({ rateLimit });
      const res = await handleAccountExport(deps);
      expect(res.status).toBe(200);
    }
    const { deps } = makeDeps({ rateLimit });
    const res = await handleAccountExport(deps);
    expect(res.status).toBe(429);
    expect(await res.text()).toBe(EXPORT_RATE_LIMIT_LINE);
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  test("after the window the export works again", async () => {
    let at = NOW.getTime();
    const limiter = createExportRateLimiter(3, 10 * 60 * 1000, () => new Date(at));
    for (let i = 0; i < 3; i++) {
      const { deps } = makeDeps({ rateLimit: (userId) => limiter(userId, new Date(at)) });
      expect((await handleAccountExport(deps)).status).toBe(200);
    }
    at += 10 * 60 * 1000 + 1000;
    const { deps } = makeDeps({ rateLimit: (userId) => limiter(userId, new Date(at)) });
    expect((await handleAccountExport(deps)).status).toBe(200);
  });

  test("the real deps builder wires the session, the user row and the storage client", async () => {
    // Smoke: the lazy real deps object exposes the three hooks and nothing
    // touches env or the network while being built.
    const { realExportRouteDeps } = await import("../../lib/account/export-route");
    const deps = realExportRouteDeps();
    expect(typeof deps.sessionUserId).toBe("function");
    expect(typeof deps.userExists).toBe("function");
    expect(typeof deps.build).toBe("function");
    expect(typeof deps.rateLimit).toBe("function");
  });
});
