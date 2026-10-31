import { describe, expect, test } from "bun:test";
import type { RefundDeps } from "../../scripts/refund-stars";
import { planRefund, refundStars } from "../../scripts/refund-stars";

describe("planRefund (pure arg parsing)", () => {
  test("parses a dry run by default", () => {
    expect(planRefund(["--user", "101", "--charge", "charge-1"])).toEqual({
      ok: true,
      userId: 101,
      chargeId: "charge-1",
      perform: false,
    });
  });

  test("parses --yes in any position", () => {
    expect(planRefund(["--yes", "--charge", "charge-1", "--user", "101"])).toEqual({
      ok: true,
      userId: 101,
      chargeId: "charge-1",
      perform: true,
    });
  });

  test("rejects missing, non-numeric or non-positive users", () => {
    for (const argv of [
      [],
      ["--charge", "charge-1"],
      ["--user", "abc", "--charge", "charge-1"],
      ["--user", "0", "--charge", "charge-1"],
      ["--user", "-5", "--charge", "charge-1"],
    ]) {
      const parsed = planRefund(argv);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.usage).toMatch(/refund-stars/);
    }
  });

  test("rejects a missing or empty charge id and unknown flags", () => {
    for (const argv of [
      ["--user", "101"],
      ["--user", "101", "--charge", ""],
      ["--user", "101", "--charge", "   "],
      ["--user", "101", "--charge", "charge-1", "--force"],
    ]) {
      expect(planRefund(argv).ok).toBe(false);
    }
  });
});

describe("refundStars (orchestration with fakes)", () => {
  function makeDeps(overrides: Partial<RefundDeps> = {}) {
    const calls: string[] = [];
    const deps: RefundDeps = {
      refundStarPayment: async (userId, chargeId) => {
        calls.push(`refund:${userId}:${chargeId}`);
        return true;
      },
      markSubscriptionCanceled: async (userId, chargeId) => {
        calls.push(`cancel:${userId}:${chargeId}`);
      },
      recordBillingEvent: async (id, provider) => {
        calls.push(`event:${id}:${provider}`);
      },
      ...overrides,
    };
    return { deps, calls };
  }

  test("dry run prints the plan and touches nothing", async () => {
    const lines: string[] = [];
    const { deps, calls } = makeDeps();
    const outcome = await refundStars(deps, { userId: 101, chargeId: "charge-1", perform: false }, (m) =>
      lines.push(m),
    );
    expect(outcome).toEqual({ kind: "dry_run" });
    expect(lines.join(" ")).toContain("Dry run");
    expect(lines.join(" ")).toContain("--yes");
    expect(calls).toEqual([]);
  });

  test("with --yes it refunds, cancels the subscription and records the event", async () => {
    const { deps, calls } = makeDeps();
    const outcome = await refundStars(deps, { userId: 101, chargeId: "charge-1", perform: true });
    expect(outcome).toEqual({ kind: "refunded" });
    expect(calls).toEqual([
      "refund:101:charge-1",
      "cancel:101:charge-1",
      "event:stars:refund:charge-1:stars",
    ]);
  });

  test("a failed refund call stops before any bookkeeping", async () => {
    const { deps, calls } = makeDeps({
      refundStarPayment: async () => {
        throw new Error("charge already refunded");
      },
    });
    const outcome = await refundStars(deps, { userId: 101, chargeId: "charge-1", perform: true });
    expect(outcome).toEqual({ kind: "failed", message: "charge already refunded" });
    expect(calls).toEqual([]);
  });

  test("bookkeeping after a successful refund never undoes it", async () => {
    const lines: string[] = [];
    const { deps, calls } = makeDeps({
      markSubscriptionCanceled: async () => {
        throw new Error("db down");
      },
    });
    const outcome = await refundStars(
      deps,
      { userId: 101, chargeId: "charge-1", perform: true },
      (m) => lines.push(m),
    );
    expect(outcome).toEqual({ kind: "refunded" });
    expect(calls).toEqual(["refund:101:charge-1"]);
    expect(lines.join(" ")).toContain("bookkeeping failed");
  });
});
