import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import { startProCheckout, type ProCheckoutDeps } from "@/app/(dashboard)/billing/start-pro-checkout";
import { TERMS_VERSION } from "../../lib/legal/version";

// The confirm gate and checkout flow for /billing, on injected fakes only: a
// recording Supabase fake for purchase_confirmations and a recording Stripe
// session creator. No global module mocks: bun shares one module registry
// across the whole test process, so nothing here poisons other files.

const USER_ID = "3f9d1c2e-1111-4111-8111-111111111111";

function makeClient(opts: { insertError?: string } = {}) {
  const inserts: Array<Record<string, unknown>> = [];
  const client = {
    from(table: string) {
      if (table !== "purchase_confirmations") throw new Error(`unexpected table ${table}`);
      return {
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
      };
    },
  };
  return { client: client as unknown as SupabaseClient, inserts };
}

type SessionSpy = {
  sessions: Array<Stripe.Checkout.SessionCreateParams>;
  createSession: (params: Stripe.Checkout.SessionCreateParams) => Promise<{ url: string | null }>;
};

function makeStripe(): SessionSpy {
  const sessions: Array<Stripe.Checkout.SessionCreateParams> = [];
  return {
    sessions,
    createSession: async (params) => {
      sessions.push(params);
      return { id: "cs_test_1", url: "https://stripe.test/checkout" };
    },
  };
}

const OPEN_ENV = {
  STRIPE_SECRET_KEY: "sk_test_123",
  STRIPE_WEBHOOK_SECRET: "whsec_123",
  STRIPE_PRICE_PRO_MONTHLY: "price_monthly",
  STRIPE_PRICE_PRO_YEARLY: "price_yearly",
  STRIPE_PRICE_PRO_YEARLY_PAYNOW: "price_paynow",
};

function makeDeps(opts: { insertError?: string; billingEnabled?: boolean } = {}) {
  const { client, inserts } = makeClient(opts);
  const stripe = makeStripe();
  const deps: ProCheckoutDeps & { inserts: Array<Record<string, unknown>>; sessions: SessionSpy["sessions"] } = {
    client,
    billingEnabled: () => opts.billingEnabled ?? true,
    envConfig: OPEN_ENV,
    baseUrl: () => "https://settle.example.com",
    createSession: stripe.createSession,
    inserts,
    sessions: stripe.sessions,
  };
  return deps;
}

function form(interval: string, confirm?: string): FormData {
  const data = new FormData();
  if (confirm !== undefined) data.set("confirm", confirm);
  data.set("interval", interval);
  return data;
}

describe("startProCheckout confirm gate", () => {
  test("missing confirm: no write and no Stripe call", async () => {
    const deps = makeDeps();
    const outcome = await startProCheckout(USER_ID, form("monthly"), deps);
    expect(outcome).toEqual({ kind: "missing_confirm" });
    expect(deps.inserts).toEqual([]);
    expect(deps.sessions).toEqual([]);
  });

  test("a confirm value that is not exactly on counts as missing", async () => {
    const deps = makeDeps();
    const outcome = await startProCheckout(USER_ID, form("monthly", "yes"), deps);
    expect(outcome).toEqual({ kind: "missing_confirm" });
    expect(deps.inserts).toEqual([]);
    expect(deps.sessions).toEqual([]);
  });

  test("present confirm: the evidence row lands, then the session is created", async () => {
    const deps = makeDeps();
    const outcome = await startProCheckout(USER_ID, form("monthly", "on"), deps);
    expect(outcome).toEqual({ kind: "checkout", url: "https://stripe.test/checkout" });
    expect(deps.inserts).toEqual([
      { user_id: USER_ID, channel: "web", terms_version: TERMS_VERSION },
    ]);
    expect(deps.sessions).toHaveLength(1);
    expect(deps.sessions[0]!.mode).toBe("subscription");
    expect(deps.sessions[0]!.client_reference_id).toBe(USER_ID);
    expect(deps.sessions[0]!.line_items).toEqual([{ price: "price_monthly", quantity: 1 }]);
  });

  test("the yearly button passes the same gate", async () => {
    const deps = makeDeps();
    const outcome = await startProCheckout(USER_ID, form("yearly", "on"), deps);
    expect(outcome).toEqual({ kind: "checkout", url: "https://stripe.test/checkout" });
    expect(deps.inserts).toHaveLength(1);
    expect(deps.sessions[0]!.line_items).toEqual([{ price: "price_yearly", quantity: 1 }]);
  });

  test("PayNow rides the same confirm field and server check", async () => {
    const deps = makeDeps();
    const outcome = await startProCheckout(USER_ID, form("paynow", "on"), deps);
    expect(outcome).toEqual({ kind: "checkout", url: "https://stripe.test/checkout" });
    expect(deps.inserts).toHaveLength(1);
    expect(deps.sessions[0]!.metadata).toEqual({ user_id: USER_ID, kind: "paynow_yearly" });
  });

  test("an insert failure: confirm_failed and no session", async () => {
    const deps = makeDeps({ insertError: "db down" });
    const outcome = await startProCheckout(USER_ID, form("monthly", "on"), deps);
    expect(outcome).toEqual({ kind: "confirm_failed" });
    expect(deps.inserts).toHaveLength(1); // the attempt happened
    expect(deps.sessions).toEqual([]);
  });

  test("an invalid interval is still refused, after the confirmation is recorded", async () => {
    const deps = makeDeps();
    const outcome = await startProCheckout(USER_ID, form("weekly", "on"), deps);
    expect(outcome).toEqual({ kind: "checkout", url: "/billing?status=error" });
    expect(deps.inserts).toHaveLength(1);
    expect(deps.sessions).toEqual([]);
  });

  test("billing off: the checkout is refused too", async () => {
    const deps = makeDeps({ billingEnabled: false });
    const outcome = await startProCheckout(USER_ID, form("monthly", "on"), deps);
    expect(outcome).toEqual({ kind: "checkout", url: "/billing?status=error" });
    expect(deps.sessions).toEqual([]);
  });
});

// The action itself is a thin wrapper: the session and terms re-check come
// first, then the core, then exactly one redirect per outcome. Pinned as
// source, since calling it needs Next's runtime.
describe("startCheckout action wrapper", () => {
  const SOURCE = readFileSync(
    join(import.meta.dir, "../../app/(dashboard)/billing/actions.ts"),
    "utf8",
  );

  test("the terms acceptance re-check runs before the checkout core", () => {
    expect(SOURCE).toContain("hasAcceptedCurrentTerms(row)");
    expect(SOURCE.indexOf("acceptedBillingUserId()")).toBeLessThan(
      SOURCE.indexOf("startProCheckout("),
    );
  });

  test("every outcome maps to exactly one redirect target", () => {
    expect(SOURCE).toContain('redirect("/billing?status=confirm_needed")');
    expect(SOURCE).toContain('redirect("/billing?status=confirm_failed")');
    expect(SOURCE).toContain("redirect(outcome.url)");
    expect(SOURCE).toContain('redirect(acceptRedirectPath("/billing"))');
  });

  test("no em or en dashes in the action or the core", () => {
    const core = readFileSync(
      join(import.meta.dir, "../../app/(dashboard)/billing/start-pro-checkout.ts"),
      "utf8",
    );
    expect(SOURCE).not.toMatch(/[\u2013\u2014]/);
    expect(core).not.toMatch(/[\u2013\u2014]/);
  });
});
