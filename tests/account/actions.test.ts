import { describe, expect, test } from "bun:test";
import { EraseStepError } from "../../lib/privacy/erase";
import type { EraseReport } from "../../lib/privacy/erase";
import {
  performDeleteAccount,
  performLogOut,
  type AccountActionDeps,
  type DeleteAccountDeps,
  type SubscriptionRowLike,
} from "../../lib/account/delete";

// The server action bodies (performLogOut, performDeleteAccount) run here on
// plain fakes: no module mocks at all. The redirect is captured, the cookie
// store records every set, and the deletion core gets scripted rows and
// reports, so the exact redirect targets and cookie behaviour are asserted.

const SESSION_USER = "ddddddd1-0000-4000-8000-000000000004";
const TELEGRAM_ID = 101;

const USER_ROW = {
  id: SESSION_USER,
  telegram_user_id: TELEGRAM_ID,
  telegram_chat_id: TELEGRAM_ID,
  first_name: "Wei",
  timezone: "Asia/Singapore",
  terms_accepted_at: "2026-10-31T01:00:00.000Z",
  terms_version: "2026-11-01",
  created_at: "2026-10-01T01:00:00.000Z",
};

function row(overrides: Partial<SubscriptionRowLike> = {}): SubscriptionRowLike {
  return {
    provider: "stripe",
    provider_ref: "sub_123",
    plan: "pro",
    status: "active",
    current_period_end: "2026-12-31T16:00:00.000Z",
    ...overrides,
  };
}

function report(overrides: Partial<EraseReport> = {}): EraseReport {
  return {
    status: "erased",
    userId: SESSION_USER,
    completedSteps: ["blockers", "scrub", "storage", "delete_user", "verify"],
    blockers: [],
    filesBefore: 1,
    filesRemoved: 1,
    eventsMatched: 0,
    eventsScrubbed: 0,
    externalRecords: { stripe: [] },
    ...overrides,
  };
}

function harness(options: {
  rows?: SubscriptionRowLike[];
  erase?: EraseReport | Error;
  userRow?: typeof USER_ROW | null;
  sessionThrows?: boolean;
} = {}) {
  const capturedSets: Array<Record<string, unknown>> = [];
  const eraseCalls: Array<{ userId: string; telegramUserId: number | undefined }> = [];
  const listCalls: string[] = [];

  const deletion: DeleteAccountDeps = {
    listSubscriptions: async (userId) => {
      listCalls.push(userId);
      return options.rows ?? [];
    },
    erase: async ({ userId, telegramUserId }) => {
      eraseCalls.push({ userId, telegramUserId });
      const result = options.erase ?? report();
      if (result instanceof Error) throw result;
      return result;
    },
  };

  const deps: AccountActionDeps = {
    session: async () => {
      if (options.sessionThrows) throw new Error("NEXT_REDIRECT:/auth/expired (session gate)");
      return SESSION_USER;
    },
    getUser: async () => (options.userRow === undefined ? USER_ROW : options.userRow),
    deletion,
    cookies: (async () => ({
      set: (o: Record<string, unknown>) => {
        capturedSets.push(o);
      },
    })) as AccountActionDeps["cookies"],
    baseUrl: () => "https://settle.example.com",
    redirectTo: (location: string): never => {
      throw new Error(`NEXT_REDIRECT:${location}`);
    },
  };

  return { deps, capturedSets, eraseCalls, listCalls };
}

async function redirectOf(run: () => Promise<void>): Promise<string> {
  try {
    await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    expect(message.startsWith("NEXT_REDIRECT:")).toBe(true);
    return message.replace("NEXT_REDIRECT:", "");
  }
  throw new Error("the action did not redirect");
}

function formData(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) fd.append(key, value);
  return fd;
}

describe("performLogOut", () => {
  test("clears the session cookie and redirects to /login", async () => {
    const h = harness();
    const location = await redirectOf(() => performLogOut(h.deps));
    expect(location).toBe("/login");
    expect(h.capturedSets).toEqual([
      {
        name: "settle_session",
        value: "",
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: true,
        maxAge: 0,
      },
    ]);
  });
});

describe("performDeleteAccount", () => {
  test("success erases once for the session user, clears the cookie, leaves the app", async () => {
    const h = harness();
    const location = await redirectOf(() =>
      performDeleteAccount(h.deps, formData({ confirm_word: "DELETE", confirm_box: "on" })),
    );
    expect(location).toBe("/account-deleted");
    expect(h.eraseCalls).toEqual([{ userId: SESSION_USER, telegramUserId: TELEGRAM_ID }]);
    expect(h.listCalls).toEqual([SESSION_USER]);
    expect(h.capturedSets).toHaveLength(1);
    expect(h.capturedSets[0]).toMatchObject({ name: "settle_session", maxAge: 0, value: "" });
  });

  test("a user id in the form data is ignored: the session id is used", async () => {
    const h = harness();
    await redirectOf(() =>
      performDeleteAccount(
        h.deps,
        formData({ confirm_word: "DELETE", confirm_box: "on", user_id: "eeeeeee1-0000-4000-8000-000000000005" }),
      ),
    );
    expect(h.eraseCalls[0]?.userId).toBe(SESSION_USER);
    expect(h.listCalls).toEqual([SESSION_USER]);
  });

  test("a wrong word refuses with no erase call and no cookie change", async () => {
    const h = harness();
    const location = await redirectOf(() => performDeleteAccount(h.deps, formData({ confirm_word: "nope" })));
    expect(location).toBe("/account?status=word_needed");
    expect(h.eraseCalls).toEqual([]);
    expect(h.capturedSets).toEqual([]);
  });

  test("a missing tick refuses with no erase call and no cookie change", async () => {
    const h = harness();
    const location = await redirectOf(() => performDeleteAccount(h.deps, formData({ confirm_word: "DELETE" })));
    expect(location).toBe("/account?status=box_needed");
    expect(h.eraseCalls).toEqual([]);
    expect(h.capturedSets).toEqual([]);
  });

  test("an active Stripe subscription blocks with cancel_first, no erase, cookie kept", async () => {
    const h = harness({ rows: [row()] });
    const location = await redirectOf(() =>
      performDeleteAccount(h.deps, formData({ confirm_word: "DELETE", confirm_box: "on" })),
    );
    expect(location).toBe("/account?status=cancel_first&kind=stripe");
    expect(h.eraseCalls).toEqual([]);
    expect(h.capturedSets).toEqual([]);
  });

  test("an active Stars subscription blocks and names Telegram", async () => {
    const h = harness({
      rows: [row({ provider: "stars", provider_ref: "charge-9", current_period_end: "2026-12-01T00:00:00.000Z" })],
    });
    const location = await redirectOf(() =>
      performDeleteAccount(h.deps, formData({ confirm_word: "DELETE", confirm_box: "on" })),
    );
    expect(location).toBe("/account?status=cancel_first&kind=stars");
    expect(h.eraseCalls).toEqual([]);
  });

  test("a past_due subscription blocks even with a lapsed period", async () => {
    const h = harness({ rows: [row({ status: "past_due", current_period_end: "2026-01-01T00:00:00.000Z" })] });
    const location = await redirectOf(() =>
      performDeleteAccount(h.deps, formData({ confirm_word: "DELETE", confirm_box: "on" })),
    );
    expect(location).toBe("/account?status=cancel_first&kind=stripe");
    expect(h.eraseCalls).toEqual([]);
  });

  test("a canceled subscription does not block", async () => {
    const h = harness({ rows: [row({ status: "canceled" })] });
    const location = await redirectOf(() =>
      performDeleteAccount(h.deps, formData({ confirm_word: "DELETE", confirm_box: "on" })),
    );
    expect(location).toBe("/account-deleted");
    expect(h.eraseCalls).toHaveLength(1);
  });

  test("an erase failure keeps the cookie and returns the student calmly", async () => {
    const h = harness({
      erase: new EraseStepError("storage", report({ status: "failed" }), new Error("bucket down")),
    });
    const location = await redirectOf(() =>
      performDeleteAccount(h.deps, formData({ confirm_word: "DELETE", confirm_box: "on" })),
    );
    expect(location).toBe("/account?status=delete_failed");
    expect(h.capturedSets).toEqual([]);
  });

  test("a session whose user row is gone redirects expired and never erases", async () => {
    const h = harness({ userRow: null });
    const location = await redirectOf(() =>
      performDeleteAccount(h.deps, formData({ confirm_word: "DELETE", confirm_box: "on" })),
    );
    expect(location).toBe("/auth/expired");
    expect(h.eraseCalls).toEqual([]);
    expect(h.listCalls).toEqual([]);
    expect(h.capturedSets).toEqual([]);
  });

  test("without a session at all the gate throws before anything runs", async () => {
    const h = harness({ sessionThrows: true });
    const location = await redirectOf(() =>
      performDeleteAccount(h.deps, formData({ confirm_word: "DELETE", confirm_box: "on" })),
    );
    expect(location).toContain("/auth/expired");
    expect(h.eraseCalls).toEqual([]);
    expect(h.capturedSets).toEqual([]);
  });
});
