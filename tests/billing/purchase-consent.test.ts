import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PURCHASE_CONFIRM_WINDOW_MINUTES,
  hasRecentConfirmation,
  latestConfirmationAt,
  recordPurchaseConfirmation,
  requireLatestConfirmationAt,
} from "../../lib/billing/purchase-consent";
import {
  PURCHASE_CONFIRM_BODY,
  PURCHASE_CONFIRM_BUTTON,
  PURCHASE_CONFIRM_CANCEL,
  PURCHASE_CONFIRM_DECLINED,
  PURCHASE_CONFIRM_FAILED,
  PURCHASE_CONFIRM_FIRST,
  PURCHASE_CONFIRM_THANKS,
  PURCHASE_CONFIRM_TITLE,
  PURCHASE_CONFIRM_WEB_ERROR,
  PURCHASE_CONFIRM_WEB_LABEL,
} from "../../lib/billing/purchase-consent-copy";
import { TERMS_VERSION } from "../../lib/legal/version";

const NOW = new Date("2026-11-02T09:00:00.000Z");
const MINUTE_MS = 60 * 1000;

// A fake Supabase client that only knows purchase_confirmations inserts and
// the newest-row read, recording every operation.
function makeClient(opts: { insertError?: string; rows?: Array<{ confirmed_at: string }>; readError?: string } = {}) {
  const inserts: Array<Record<string, unknown>> = [];
  const client = {
    from(table: string) {
      if (table !== "purchase_confirmations") throw new Error(`unexpected table ${table}`);
      const builder = {
        insert(row: Record<string, unknown>) {
          inserts.push(row);
          return {
            then(res?: (v: unknown) => unknown) {
              return Promise.resolve({
                data: null,
                error: opts.insertError ? { message: opts.insertError } : null,
              }).then(res);
            },
          };
        },
        select() {
          return builder;
        },
        eq() {
          return builder;
        },
        order() {
          return builder;
        },
        limit() {
          return builder;
        },
        maybeSingle() {
          if (opts.readError) return Promise.resolve({ data: null, error: { message: opts.readError } });
          const rows = opts.rows ?? [];
          return Promise.resolve({ data: rows[0] ?? null, error: null });
        },
      };
      return builder;
    },
  };
  return { client: client as unknown as import("@supabase/supabase-js").SupabaseClient, inserts };
}

// ---- window logic ------------------------------------------------------------

describe("hasRecentConfirmation", () => {
  const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * MINUTE_MS);

  test("the window is exactly 60 minutes", () => {
    expect(PURCHASE_CONFIRM_WINDOW_MINUTES).toBe(60);
  });

  test("59 and 60 minutes count, 61 does not", () => {
    expect(hasRecentConfirmation(at(59), NOW)).toBe(true);
    expect(hasRecentConfirmation(at(60), NOW)).toBe(true);
    expect(hasRecentConfirmation(at(61), NOW)).toBe(false);
  });

  test("null is never a confirmation", () => {
    expect(hasRecentConfirmation(null, NOW)).toBe(false);
  });

  test("a fresh confirmation counts", () => {
    expect(hasRecentConfirmation(at(0), NOW)).toBe(true);
  });

  test("a timestamp up to a minute in the future counts (clock skew), further ahead does not", () => {
    expect(hasRecentConfirmation(new Date(NOW.getTime() + 30 * 1000), NOW)).toBe(true);
    expect(hasRecentConfirmation(new Date(NOW.getTime() + 61 * 1000), NOW)).toBe(false);
    expect(hasRecentConfirmation(new Date(NOW.getTime() + 10 * MINUTE_MS), NOW)).toBe(false);
  });
});

// ---- record -------------------------------------------------------------------

describe("recordPurchaseConfirmation", () => {
  test("inserts a row with the user, channel and current TERMS_VERSION", async () => {
    const { client, inserts } = makeClient();
    const result = await recordPurchaseConfirmation(client, {
      userId: "u-1",
      channel: "telegram",
      now: NOW,
    });
    expect(result).toEqual({ ok: true });
    expect(inserts).toEqual([
      { user_id: "u-1", channel: "telegram", terms_version: TERMS_VERSION, confirmed_at: NOW.toISOString() },
    ]);
  });

  test("without a now the timestamp is left to the database default", async () => {
    const { client, inserts } = makeClient();
    await recordPurchaseConfirmation(client, { userId: "u-1", channel: "web" });
    expect(inserts[0]).toEqual({ user_id: "u-1", channel: "web", terms_version: TERMS_VERSION });
  });

  test("a database error becomes ok:false, never a throw", async () => {
    const { client, inserts } = makeClient({ insertError: "db down" });
    const result = await recordPurchaseConfirmation(client, { userId: "u-1", channel: "web" });
    expect(result).toEqual({ ok: false });
    expect(inserts).toHaveLength(1);
  });

  test("a thrown error becomes ok:false too", async () => {
    const client = {
      from() {
        throw new Error("client exploded");
      },
    } as unknown as import("@supabase/supabase-js").SupabaseClient;
    const result = await recordPurchaseConfirmation(client, { userId: "u-1", channel: "web" });
    expect(result).toEqual({ ok: false });
  });
});

// ---- latest lookup --------------------------------------------------------------

describe("latestConfirmationAt", () => {
  test("returns the stored timestamp", async () => {
    const { client } = makeClient({ rows: [{ confirmed_at: NOW.toISOString() }] });
    expect(await latestConfirmationAt(client, "u-1")).toEqual(NOW);
    expect(await requireLatestConfirmationAt(client, "u-1")).toEqual(NOW);
  });

  test("no rows means null", async () => {
    const { client } = makeClient({ rows: [] });
    expect(await latestConfirmationAt(client, "u-1")).toBeNull();
    expect(await requireLatestConfirmationAt(client, "u-1")).toBeNull();
  });

  test("a read error is null for the safe variant and throws for the strict one", async () => {
    const { client } = makeClient({ readError: "db down" });
    expect(await latestConfirmationAt(client, "u-1")).toBeNull();
    await expect(requireLatestConfirmationAt(client, "u-1")).rejects.toThrow("db down");
  });

  test("a garbage timestamp reads as never confirmed", async () => {
    const { client } = makeClient({ rows: [{ confirmed_at: "not a date" }] });
    expect(await latestConfirmationAt(client, "u-1")).toBeNull();
  });
});

// ---- copy -----------------------------------------------------------------------

describe("purchase confirm copy", () => {
  test("every string matches the agreed wording exactly", () => {
    expect(PURCHASE_CONFIRM_TITLE).toBe("Before you pay");
    expect(PURCHASE_CONFIRM_BODY).toBe(
      "Pro is a paid plan. You must be 18 or older, or have a parent or guardian who has read the Terms and agreed to this purchase.",
    );
    expect(PURCHASE_CONFIRM_BUTTON).toBe("I am 18 or older, or a parent or guardian agreed");
    expect(PURCHASE_CONFIRM_CANCEL).toBe("Not now");
    expect(PURCHASE_CONFIRM_THANKS).toBe("Thanks. Your payment is ready below.");
    expect(PURCHASE_CONFIRM_DECLINED).toBe("No problem. Send /pro whenever you want to upgrade.");
    expect(PURCHASE_CONFIRM_FIRST).toBe(
      "Please confirm first: send /pro and tap the confirm button. You have not been charged.",
    );
    expect(PURCHASE_CONFIRM_WEB_LABEL).toBe("I am 18 or older, or a parent or guardian agreed");
    expect(PURCHASE_CONFIRM_WEB_ERROR).toBe(
      "Please tick the box to continue. You have not been charged.",
    );
    expect(PURCHASE_CONFIRM_FAILED).toBe(
      "I could not save that just now. Please try again in a minute. You have not been charged.",
    );
  });

  test("every string carries no em or en dash", () => {
    for (const text of [
      PURCHASE_CONFIRM_TITLE,
      PURCHASE_CONFIRM_BODY,
      PURCHASE_CONFIRM_BUTTON,
      PURCHASE_CONFIRM_CANCEL,
      PURCHASE_CONFIRM_THANKS,
      PURCHASE_CONFIRM_DECLINED,
      PURCHASE_CONFIRM_FIRST,
      PURCHASE_CONFIRM_WEB_LABEL,
      PURCHASE_CONFIRM_WEB_ERROR,
      PURCHASE_CONFIRM_FAILED,
    ]) {
      expect(text).not.toMatch(/[\u2013\u2014]/);
    }
  });

  test("the copy leaf stays client safe: no server-only import in its source", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../lib/billing/purchase-consent-copy.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/server-only/);
    expect(source).not.toMatch(/^import /m);
  });
});
