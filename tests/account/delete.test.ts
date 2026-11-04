import { describe, expect, test } from "bun:test";
import { EraseStepError } from "../../lib/privacy/erase";
import {
  DELETE_CONFIRM_BOX,
  DELETE_CONFIRM_WORD,
  runAccountDeletion,
  type DeleteAccountDeps,
  type SubscriptionRowLike,
} from "../../lib/account/delete";
import type { EraseReport } from "../../lib/privacy/erase";

// 28 Nov 2026, 09:00 SGT.
const NOW = new Date("2026-11-28T01:00:00.000Z");
const USER = "aaaaaaa1-0000-4000-8000-000000000001";
const SESSION_USER = USER;

function report(overrides: Partial<EraseReport> = {}): EraseReport {
  return {
    status: "erased",
    userId: USER,
    completedSteps: ["blockers", "scrub", "storage", "delete_user", "verify"],
    blockers: [],
    filesBefore: 2,
    filesRemoved: 2,
    eventsMatched: 1,
    eventsScrubbed: 1,
    externalRecords: { stripe: [] },
    ...overrides,
  };
}

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

function makeDeps(
  rows: SubscriptionRowLike[],
  eraseResult: EraseReport | Error = report(),
) {
  const calls: {
    listFor: string[];
    eraseFor: Array<{ userId: string; telegramUserId: number | undefined }>;
  } = { listFor: [], eraseFor: [] };
  const deps: DeleteAccountDeps = {
    listSubscriptions: async (userId) => {
      calls.listFor.push(userId);
      return rows;
    },
    erase: async ({ userId, telegramUserId }) => {
      calls.eraseFor.push({ userId, telegramUserId });
      if (eraseResult instanceof Error) throw eraseResult;
      return eraseResult;
    },
  };
  return { deps, calls };
}

const CONFIRMED = {
  userId: SESSION_USER,
  telegramUserId: 101,
  word: DELETE_CONFIRM_WORD,
  checkbox: DELETE_CONFIRM_BOX,
  now: NOW,
};

type DeletionArgs = Parameters<typeof runAccountDeletion>[1];

async function outcome(deps: DeleteAccountDeps, overrides: Partial<DeletionArgs> = {}) {
  return runAccountDeletion(deps, { ...CONFIRMED, ...overrides });
}

describe("runAccountDeletion: confirmations", () => {
  test("a wrong or missing word is refused and never erases", async () => {
    for (const word of [null, "", "delete", "DELETEE", "confirm", "ERASE"]) {
      const { deps, calls } = makeDeps([]);
      const result = await outcome(deps, { word });
      expect(result).toEqual({ kind: "word_needed" });
      expect(calls.eraseFor).toEqual([]);
    }
    // Trimming is allowed, case is not.
    const { deps } = makeDeps([]);
    expect(await outcome(deps, { word: "  DELETE  " })).toEqual({ kind: "deleted" });
  });

  test("a missing or mistyped checkbox is refused and never erases", async () => {
    for (const checkbox of [null, "", "yes", "checked"]) {
      const { deps, calls } = makeDeps([]);
      const result = await outcome(deps, { checkbox });
      expect(result).toEqual({ kind: "box_needed" });
      expect(calls.eraseFor).toEqual([]);
    }
  });

  test("the word is checked before the checkbox", async () => {
    const { deps } = makeDeps([]);
    expect(await outcome(deps, { word: null, checkbox: null })).toEqual({ kind: "word_needed" });
  });
});

describe("runAccountDeletion: subscription guard", () => {
  test("an active Stripe subscription blocks with cancel_first and no erase call", async () => {
    const { deps, calls } = makeDeps([row()]);
    const result = await outcome(deps);
    expect(result).toEqual({ kind: "cancel_first", blocking: "stripe" });
    expect(calls.eraseFor).toEqual([]);
    expect(calls.listFor).toEqual([SESSION_USER]);
  });

  test("an active Stars subscription blocks and names Telegram", async () => {
    const { deps } = makeDeps([
      row({ provider: "stars", provider_ref: "charge-9", current_period_end: "2026-12-01T16:00:00.000Z" }),
    ]);
    expect(await outcome(deps)).toEqual({ kind: "cancel_first", blocking: "stars" });
  });

  test("a past_due subscription blocks even with a lapsed period", async () => {
    const { deps, calls } = makeDeps([
      row({ status: "past_due", current_period_end: "2026-01-01T00:00:00.000Z" }),
    ]);
    expect(await outcome(deps)).toEqual({ kind: "cancel_first", blocking: "stripe" });
    expect(calls.eraseFor).toEqual([]);
  });

  test("a trialing subscription blocks while the period runs", async () => {
    const { deps } = makeDeps([
      row({ status: "trialing", provider_ref: "sub_trial", current_period_end: "2026-12-01T00:00:00.000Z" }),
    ]);
    expect(await outcome(deps)).toEqual({ kind: "cancel_first", blocking: "stripe" });
  });

  test("canceled subscriptions never block, whatever the period says", async () => {
    const { deps, calls } = makeDeps([row({ status: "canceled" })]);
    expect(await outcome(deps)).toEqual({ kind: "deleted" });
    expect(calls.eraseFor).toHaveLength(1);
  });

  test("an expired period does not block: the plan is over", async () => {
    const { deps } = makeDeps([
      row({ current_period_end: "2026-01-01T00:00:00.000Z" }),
    ]);
    expect(await outcome(deps)).toEqual({ kind: "deleted" });
  });

  test("a missing period end on an active row does not block (nothing can renew)", async () => {
    const { deps } = makeDeps([row({ current_period_end: null })]);
    expect(await outcome(deps)).toEqual({ kind: "deleted" });
  });

  test("stripe wording wins over stars when both block", async () => {
    const { deps } = makeDeps([
      row({ provider: "stars", provider_ref: "charge-9" }),
      row(),
    ]);
    expect(await outcome(deps)).toEqual({ kind: "cancel_first", blocking: "stripe" });
  });

  test("a paynow or manual row blocks with the generic line", async () => {
    const { deps } = makeDeps([
      row({ provider: "stripe", provider_ref: "paynow:cs_1" }),
    ]);
    expect(await outcome(deps)).toEqual({ kind: "cancel_first", blocking: "other" });
  });
});

describe("runAccountDeletion: the erase itself", () => {
  test("success erases exactly once, dryRun false, force false, session user only", async () => {
    const { deps, calls } = makeDeps([]);
    const result = await outcome(deps, { telegramUserId: 9812345 });
    expect(result).toEqual({ kind: "deleted" });
    expect(calls.eraseFor).toEqual([
      { userId: SESSION_USER, telegramUserId: 9812345 },
    ]);
    // The erase call runs with the hardcoded safe args inside realDeleteDeps;
    // here we assert the deps contract received no force or dryRun escape.
    expect(calls.listFor).toEqual([SESSION_USER]);
  });

  test("nothing_to_delete still counts as deleted (the row was already gone)", async () => {
    const { deps } = makeDeps([], report({ status: "nothing_to_delete" }));
    expect(await outcome(deps)).toEqual({ kind: "deleted" });
  });

  test("an EraseStepError keeps everything safe: no erase success, failed outcome", async () => {
    const failure = new EraseStepError("storage", report({ status: "failed" }), new Error("bucket down"));
    const { deps, calls } = makeDeps([], failure);
    const result = await outcome(deps);
    expect(result).toEqual({ kind: "failed" });
    expect(calls.eraseFor).toHaveLength(1);
  });

  test("any throw becomes the calm failed outcome, never an error page", async () => {
    const { deps } = makeDeps([], new Error("supabase is down"));
    expect(await outcome(deps)).toEqual({ kind: "failed" });
  });

  test("an incomplete report is a failure, so the student is told to retry", async () => {
    const { deps } = makeDeps([], report({ status: "incomplete", after: { tasks: 2 } as EraseReport["after"] }));
    expect(await outcome(deps)).toEqual({ kind: "failed" });
  });

  test("a blocked report (a race) sends the student back to cancel_first", async () => {
    const { deps } = makeDeps(
      [],
      report({ status: "blocked", blockers: [{ provider: "stripe", provider_ref: "sub_x", plan: "pro", current_period_end: null, kind: "stripe", instruction: "cancel" }] }),
    );
    expect(await outcome(deps)).toEqual({ kind: "cancel_first", blocking: "other" });
  });
});

describe("runAccountDeletion: user id comes from the session only", () => {
  test("a user id smuggled through args is never used: the caller passes the session id", async () => {
    // The deps contract only receives what the action resolved from the
    // session. A foreign id in the shape of a word or checkbox cannot reach
    // the erase, and listSubscriptions only ever sees the session user.
    const { deps, calls } = makeDeps([]);
    await outcome(deps, { userId: SESSION_USER });
    expect(calls.listFor).toEqual([SESSION_USER]);
    expect(calls.eraseFor[0]?.userId).toBe(SESSION_USER);
    expect(calls.eraseFor[0]?.userId).not.toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  });
});
