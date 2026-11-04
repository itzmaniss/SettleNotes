import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

mock.module("next/navigation", () => ({ usePathname: () => "/dashboard" }));

const { Nav } = await import("../../components/marketing/nav");
const { DashboardNav } = await import("../../components/dashboard/nav");
const { DashboardFooter } = await import("../../components/dashboard/footer");
const { PlanCard } = await import("../../components/dashboard/plan-card");
const { BillingPanel } = await import("../../components/billing/billing-panel");
const { buildBillingPageView, CLOSED_NOTE, freeCoverLine } = await import("../../lib/billing/view");

const render = (el: React.ReactElement) => renderToStaticMarkup(el);
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);

describe("public site header", () => {
  test("section links work from any page, not just the landing page", () => {
    const html = render(React.createElement(Nav));
    expect(hrefs(html)).toContain("/#how");
    expect(hrefs(html)).toContain("/#pricing");
    expect(hrefs(html)).not.toContain("#how");
    expect(hrefs(html)).toContain("/");
    expect(html).toContain('aria-label="Site"');
  });

  test("hideLogin drops only the Log in link", () => {
    expect(hrefs(render(React.createElement(Nav)))).toContain("/login");
    expect(hrefs(render(React.createElement(Nav, { hideLogin: true })))).not.toContain("/login");
  });
});

describe("every public page carries the header and the footer", () => {
  const files = [
    "app/faq/page.tsx",
    "app/login/page.tsx",
    "app/accept/page.tsx",
    "app/account-deleted/page.tsx",
    "app/guides/page.tsx",
    "app/guides/[slug]/page.tsx",
    "components/legal/legal-document.tsx",
  ];
  for (const file of files) {
    test(file, () => {
      const src = readFileSync(file, "utf8");
      expect(src).toContain("@/components/marketing/nav");
      expect(src).toContain("@/components/marketing/footer");
      expect(src).toMatch(/<Nav[\s/>]/);
      expect(src).toMatch(/<Footer[\s/>]/);
    });
  }
});

describe("dashboard navigation", () => {
  const html = render(React.createElement(DashboardNav, { todayLabel: "Wed 5 Nov" }));

  test("Plan is a pill from sm up and hidden on phones", () => {
    const plan = /<a [^>]*href="\/billing"[^>]*class="[^"]*hidden sm:flex[^"]*"[^>]*>|<a [^>]*class="[^"]*hidden sm:flex[^"]*"[^>]*href="\/billing"[^>]*>/.exec(html);
    expect(plan).not.toBeNull();
  });

  test("phones get one slim row with Plan, Home page and Help, and nothing wider", () => {
    const row = /<div class="[^"]*sm:hidden[^"]*">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "";
    expect(hrefs(row)).toEqual(["/billing", "/", "/faq"]);
    expect(row).toContain("Plan");
    expect(row).toContain("Home page");
    expect(row).toContain("Help");
    expect(row.match(/min-h-\[44px\]/g)?.length).toBe(3);
  });

  test("the pill row keeps four phone pills and adds Plan only from sm up", () => {
    const nav = /<nav aria-label="Dashboard"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? "";
    const links = [...nav.matchAll(/<a [^>]*>/g)].map((m) => m[0]);
    expect(links.length).toBe(5); // Tasks, Study, Weak spots, Account, Plan
    const visibleOnPhone = links.filter((l) => !/class="[^"]*\bhidden\b/.test(l));
    expect(visibleOnPhone.length).toBe(4);
  });
});

describe("dashboard footer", () => {
  test("links home, guides and help, plus the legal links", () => {
    const html = render(React.createElement(DashboardFooter));
    expect(html.match(/<footer/g)?.length).toBe(1);
    for (const href of ["/", "/guides", "/faq", "/terms", "/privacy", "/refund"]) {
      expect(hrefs(html)).toContain(href);
    }
  });
});

describe("plan card always reaches /billing", () => {
  const view = {
    planName: "Free",
    rows: [],
    resetsOn: "1 Dec",
  } as never;

  test("billing closed: See plans plus the honest note, no buy button", () => {
    const html = render(React.createElement(PlanCard, { view }));
    expect(hrefs(html)).toContain("/billing");
    expect(html).toContain("See plans");
    expect(html).toContain(CLOSED_NOTE);
    expect(html).not.toMatch(/\sdisabled[=\s>]/);
  });

  test("billing open and Free: See plans, no closed note", () => {
    const html = render(React.createElement(PlanCard, { view, billingOpen: true }));
    expect(html).toContain("See plans");
    expect(html).not.toContain(CLOSED_NOTE);
  });

  test("billing open and Pro: Manage plan", () => {
    const html = render(React.createElement(PlanCard, { view: { ...(view as object), planName: "Pro" } as never, billingOpen: true }));
    expect(html).toContain("Manage plan");
    expect(hrefs(html)).toContain("/billing");
  });
});

describe("billing page wording", () => {
  const noop = () => {};
  const base = {
    usage: {},
    now: new Date("2026-11-05T00:00:00Z"),
    activeStripeRef: null,
    starsActive: false,
    status: undefined,
  };

  test("closed: the note and what Free covers, built from the plan numbers", () => {
    const view = buildBillingPageView({ ...base, plan: "free", periodEnd: null, billingEnabled: false, env: {} } as never);
    const html = render(React.createElement(BillingPanel, { view, startCheckout: noop, openPortal: noop }));
    expect(html).toContain(CLOSED_NOTE);
    expect(html).toContain(freeCoverLine());
    expect(freeCoverLine()).toContain("maths checks");
    expect(html).not.toContain("Choose ");
  });

  test("stripe subscriber: portal button and the three plain lines", () => {
    const view = buildBillingPageView({
      ...base,
      plan: "pro",
      periodEnd: "2026-12-01T00:00:00Z",
      billingEnabled: true,
      env: { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x", STRIPE_PRICE_PRO_MONTHLY: "price_m", STRIPE_PRICE_PRO_YEARLY: "price_y" },
      activeStripeRef: "sub_123",
    } as never);
    const html = render(React.createElement(BillingPanel, { view, startCheckout: noop, openPortal: noop }));
    expect(html).toContain("Manage or cancel your plan");
    expect(html).toContain("change or cancel your plan");
    expect(html).toContain("keep Pro until the end of the period");
    expect(html).toContain("monthly and yearly");
  });
});

test("no dashes in the new files", () => {
  for (const f of ["components/dashboard/footer.tsx", "components/dashboard/nav.tsx", "components/dashboard/plan-card.tsx", "components/marketing/nav.tsx", "lib/billing/view.ts"]) {
    expect(readFileSync(f, "utf8")).not.toMatch(/[\u2013\u2014]/);
  }
});
