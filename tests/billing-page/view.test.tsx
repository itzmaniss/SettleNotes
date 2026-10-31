import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildBillingPageView,
  billingOptions,
  buildCurrentPlan,
  statusBanner,
  CANCELED_BANNER,
  CLOSED_NOTE,
  ERROR_BANNER,
  MANAGE_BUTTON_LABEL,
  PAYNOW_LABEL,
  SUCCESS_BANNER,
  TEST_MODE_STICKER,
  WEB_NUDGE_LINE,
  type BillingPageView,
} from "../../lib/billing/view";
import { BillingPanel } from "../../components/billing/billing-panel";
import { PLANS, formatPrice } from "../../lib/billing/plans";

// 28 Oct 2026, 09:00 SGT.
const NOW = new Date("2026-10-28T01:00:00.000Z");

const openEnv = {
  STRIPE_SECRET_KEY: "sk_test_123",
  STRIPE_WEBHOOK_SECRET: "whsec_123",
  STRIPE_PRICE_PRO_MONTHLY: "price_monthly",
  STRIPE_PRICE_PRO_YEARLY: "price_yearly",
  STRIPE_PRICE_PRO_YEARLY_PAYNOW: "price_paynow",
};

const COMPONENT_DIR = join(import.meta.dir, "..", "..", "components", "billing");
const PANEL_SOURCE = readFileSync(
  join(COMPONENT_DIR, "billing-panel.tsx"),
  "utf8",
);

function freeView(overrides: Partial<Parameters<typeof buildBillingPageView>[0]> = {}): BillingPageView {
  return buildBillingPageView({
    plan: "free",
    periodEnd: null,
    usage: { math_diagnosis: 2, slides_flashcards: 1, brief_checklist: 0 },
    now: NOW,
    billingEnabled: true,
    env: openEnv,
    activeStripeRef: null,
    starsActive: false,
    status: undefined,
    ...overrides,
  });
}

function render(view: BillingPageView): string {
  return renderToStaticMarkup(
    <BillingPanel
      view={view}
      startCheckout={() => {}}
      openPortal={() => {}}
    />,
  );
}

// ---- View-model ---------------------------------------------------------------

describe("billingOptions", () => {
  test("two options derived from plans.ts, yearly notes the saving", () => {
    expect(billingOptions()).toEqual([
      {
        interval: "monthly",
        label: "Monthly",
        price: formatPrice(PLANS.pro.price.monthly, "SGD"),
        note: null,
      },
      {
        interval: "yearly",
        label: "Yearly",
        price: formatPrice(PLANS.pro.price.yearly, "SGD"),
        note: "Save 33 percent with the yearly plan",
      },
    ]);
  });
});

describe("buildCurrentPlan", () => {
  test("free keeps the usage rows; pro carries an until date in SGT", () => {
    const free = buildCurrentPlan({
      plan: "free",
      periodEnd: null,
      usage: { math_diagnosis: 3, slides_flashcards: 0, brief_checklist: 1 },
      now: NOW,
    });
    expect(free.planName).toBe("Free");
    expect(free.until).toBeNull();
    expect(free.usage.rows.map((row) => `${row.used} of ${row.limit}`)).toEqual([
      "3 of 3",
      "0 of 1",
      "1 of 1",
    ]);

    // 2026-11-30T16:00Z is 1 Dec 00:00 SGT.
    const pro = buildCurrentPlan({
      plan: "pro",
      periodEnd: "2026-11-30T16:00:00.000Z",
      usage: {},
      now: NOW,
    });
    expect(pro.planName).toBe("Pro");
    expect(pro.until).toBe("1 Dec");
  });
});

describe("statusBanner", () => {
  test("the three known statuses, everything else quiet", () => {
    expect(statusBanner("success")).toEqual({ tone: "success", message: SUCCESS_BANNER });
    expect(statusBanner("canceled")).toEqual({ tone: "neutral", message: CANCELED_BANNER });
    expect(statusBanner("error")).toEqual({ tone: "error", message: ERROR_BANNER });
    expect(statusBanner(undefined)).toBeNull();
    expect(statusBanner("")).toBeNull();
    expect(statusBanner("hacked=1")).toBeNull();
  });
});

describe("buildBillingPageView", () => {
  test("open only when billing is on and Stripe is fully configured", () => {
    expect(freeView().open).toBe(true);
    expect(freeView({ billingEnabled: false }).open).toBe(false);
    expect(freeView({ env: { ...openEnv, STRIPE_WEBHOOK_SECRET: undefined } }).open).toBe(false);
    expect(
      freeView({ env: { ...openEnv, STRIPE_PRICE_PRO_YEARLY: undefined } }).open,
    ).toBe(false);
  });

  test("paynow option only when its price id is set", () => {
    expect(freeView().paynowAvailable).toBe(true);
    expect(
      freeView({ env: { ...openEnv, STRIPE_PRICE_PRO_YEARLY_PAYNOW: "price_paynow" } })
        .paynowAvailable,
    ).toBe(true);
    expect(
      freeView({ env: { ...openEnv, STRIPE_PRICE_PRO_YEARLY_PAYNOW: undefined } })
        .paynowAvailable,
    ).toBe(false);
  });

  test("portal flag requires a real subscription ref, not a paynow ref", () => {
    expect(freeView({ activeStripeRef: "sub_123" }).showPortal).toBe(true);
    expect(freeView({ activeStripeRef: "paynow:cs_1" }).showPortal).toBe(false);
    expect(freeView({ activeStripeRef: null }).showPortal).toBe(false);
  });

  test("test mode sticker only for an sk_test_ key", () => {
    expect(freeView().testMode).toBe(true);
    expect(freeView({ env: { ...openEnv, STRIPE_SECRET_KEY: "sk_live_9" } }).testMode).toBe(
      false,
    );
    expect(freeView({ env: { ...openEnv, STRIPE_SECRET_KEY: undefined } }).testMode).toBe(
      false,
    );
  });
});

// ---- Rendered panel ---------------------------------------------------------------

describe("BillingPanel", () => {
  test("billing off: calm closed note, nothing clickable to pay", () => {
    const html = render(freeView({ billingEnabled: false }));
    expect(html).toContain("Plan and billing");
    expect(html).toContain(CLOSED_NOTE);
    expect(html).not.toContain("<form");
    expect(html).not.toContain("Choose");
    expect(html).not.toContain(PAYNOW_LABEL);
  });

  test("Stripe unconfigured with billing on: same closed state", () => {
    const html = render(freeView({ env: { ...openEnv, STRIPE_SECRET_KEY: undefined } }));
    expect(html).toContain(CLOSED_NOTE);
    expect(html).not.toContain("<form");
  });

  test("free with usage: both plan options carry plans.ts prices and the Telegram line", () => {
    const html = render(freeView());
    expect(html).toContain("Free");
    expect(html).toContain("2 of 3");
    expect(html).toContain(formatPrice(PLANS.pro.price.monthly, "SGD"));
    expect(html).toContain(formatPrice(PLANS.pro.price.yearly, "SGD"));
    expect(html).toContain("Save 33 percent with the yearly plan");
    expect(html).toContain('value="monthly"');
    expect(html).toContain('value="yearly"');
    expect(html).toContain("Prefer Telegram? You can also subscribe with Stars from the bot.");
    // The neutral Telegram line carries no number and no price comparison.
    expect(html).not.toMatch(/600/);
    expect(html).not.toContain("cheaper");
  });

  test("paynow option appears only when configured", () => {
    const html = render(
      freeView({ env: { ...openEnv, STRIPE_PRICE_PRO_YEARLY_PAYNOW: "price_paynow" } }),
    );
    expect(html).toContain(PAYNOW_LABEL);
    expect(html).toContain('value="paynow"');
  });

  test("pro on stripe: manage button and no purchase forms", () => {
    const html = render(
      buildBillingPageView({
        plan: "pro",
        periodEnd: "2026-11-30T16:00:00.000Z",
        usage: {},
        now: NOW,
        billingEnabled: true,
        env: openEnv,
        activeStripeRef: "sub_123",
        starsActive: false,
        status: undefined,
      }),
    );
    expect(html).toContain("Pro until 1 Dec");
    expect(html).toContain(MANAGE_BUTTON_LABEL);
    expect(html).not.toContain("Choose");
    expect(html).not.toContain('value="monthly"');
  });

  test("pro on stars: telegram manage line, no portal, no forms", () => {
    const html = render(
      buildBillingPageView({
        plan: "pro",
        periodEnd: "2026-11-30T16:00:00.000Z",
        usage: {},
        now: NOW,
        billingEnabled: true,
        env: openEnv,
        activeStripeRef: null,
        starsActive: true,
        status: undefined,
      }),
    );
    // The apostrophe is HTML escaped by React, so assert on both halves.
    expect(html).toContain("Your Pro runs through Telegram");
    expect(html).toContain("subscription settings");
    expect(html).not.toContain(MANAGE_BUTTON_LABEL);
    expect(html).not.toContain("<form");
  });

  test("status banners render from the query status", () => {
    expect(render(freeView({ status: "success" }))).toContain(SUCCESS_BANNER);
    expect(render(freeView({ status: "canceled" }))).toContain(CANCELED_BANNER);
    expect(render(freeView({ status: "error" }))).toContain(ERROR_BANNER);
    expect(render(freeView({ status: undefined }))).not.toContain(SUCCESS_BANNER);
  });

  test("test mode sticker only for an sk_test_ key", () => {
    expect(render(freeView())).toContain(TEST_MODE_STICKER);
    expect(
      render(freeView({ env: { ...openEnv, STRIPE_SECRET_KEY: "sk_live_9" } })),
    ).not.toContain(TEST_MODE_STICKER);
  });
});

// ---- Copy rules ---------------------------------------------------------------------

describe("billing copy rules", () => {
  test("no em or en dashes in the panel markup", () => {
    expect(render(freeView())).not.toMatch(/[\u2014\u2013]/);
    expect(PANEL_SOURCE).not.toMatch(/[\u2014\u2013]/);
  });

  test("no hardcoded price literals in any billing component source", () => {
    const priceLike = /S\$\s*\d|\d+\.\d{2}(?!\d)/;
    for (const file of readdirSync(COMPONENT_DIR)) {
      if (!/\.(tsx|ts)$/.test(file)) continue;
      const source = readFileSync(join(COMPONENT_DIR, file), "utf8");
      expect(source.match(priceLike) ?? [], `${file} hardcodes a price`).toEqual([]);
    }
  });

  test("no Stars number anywhere on the website billing surface", () => {
    expect(PANEL_SOURCE).not.toMatch(/\b600\b/);
    expect(render(freeView())).not.toMatch(/\b600\b/);
  });

  test("the web nudge line mentions no numbers", () => {
    expect(WEB_NUDGE_LINE).toBe("Subscribe on the web with a card or PayNow.");
    expect(WEB_NUDGE_LINE).not.toMatch(/\d/);
  });

  test("44px tap targets: every submit button rides the chunk pill", () => {
    // The panel renders all submits through ChunkButton, whose default chunk
    // size is h-11 (44px). No raw <button> is allowed here.
    expect(PANEL_SOURCE).not.toMatch(/<button/);
    expect(PANEL_SOURCE).toContain("ChunkButton");
  });
});
