import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

// The dashboard nav is a client component: its only render dependency is
// usePathname, so a fixed pathname is enough to render it statically.
mock.module("next/navigation", () => ({
  usePathname: () => "/dashboard",
  redirect: (url: string) => {
    throw new Error(`redirect to ${url}`);
  },
}));

// The login and accept pages read cookies before rendering; a bare store and
// the same fakes as tests/auth/accept-page.test.tsx keep env out of it.
mock.module("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => ({ get: () => null }),
}));

// The login page reads cookies before rendering; a bare store keeps env out of
// it. The session mock spreads the real module (telegram-login links against
// createSessionToken) and only replaces getSessionUser.
const realSession = await import("@/lib/auth/session");

mock.module("@/lib/auth/session", () => ({
  ...realSession,
  getSessionUser: async () => null,
}));

mock.module("@/lib/auth/accept", () => ({
  resolveAcceptVisitor: async () => ({
    kind: "consent" as const,
    claims: { tid: 900000001, fn: "Wei" },
  }),
  realAcceptDeps: () => ({}) as never,
  performAccept: async () => ({ kind: "anonymous" }),
}));

const { DashboardNav } = await import("@/components/dashboard/nav");
const { default: LoginPage } = await import("@/app/login/page");
const { default: AcceptPage } = await import("@/app/accept/page");
const { default: ExpiredPage } = await import("@/app/auth/expired/page");
const { ACCEPT_TITLE, ACCEPT_CONFIRM } = await import("@/lib/legal/consent-copy");
const { EXPIRED_PAGE_TITLE } = await import("@/lib/auth/copy");

const FORBIDDEN_DASH = /[\u2013\u2014]/;

// First <a href="/dashboard"> in the markup: the brand link sits before the
// Tasks link in the DOM, so the first match is the brand block.
function brandAnchor(html: string): string {
  const match = html.match(/<a[^>]*href="\/dashboard"[^>]*>[\s\S]*?<\/a>/);
  expect(match, "a /dashboard link exists").not.toBeNull();
  return match![0];
}

describe("dashboard nav brand block", () => {
  test("one /dashboard link holds the 24px aria-hidden mark and the text settle", () => {
    const html = renderToStaticMarkup(<DashboardNav todayLabel="Sat, Nov 1" />);
    const anchor = brandAnchor(html);
    expect(anchor).toContain("<svg");
    expect(anchor).toContain('width="24"');
    expect(anchor).toContain('aria-hidden="true"');
    expect(anchor).toContain(">settle<");
    // Mark before the text, both inside the same single link.
    expect(anchor.indexOf("<svg")).toBeLessThan(anchor.indexOf(">settle<"));
    expect(anchor.indexOf("</a>") > anchor.indexOf(">settle<")).toBe(true);
  });

  test("the brand link keeps the 44px tap target and the display font", () => {
    const html = renderToStaticMarkup(<DashboardNav todayLabel="Sat, Nov 1" />);
    expect(brandAnchor(html)).toContain("min-h-[44px]");
    expect(brandAnchor(html)).toContain("font-display");
  });

  test("nav keeps its links, one line per label, and never renders dashes", () => {
    const html = renderToStaticMarkup(<DashboardNav todayLabel="Sat, Nov 1" />);
    expect(html).toContain('aria-label="Dashboard"');
    expect(html).toContain("Tasks");
    expect(html).toContain("Study");
    expect(html).toContain("Weak spots");
    // Labels refuse to wrap so the pill stays one row at 390px.
    expect(html).toContain("whitespace-nowrap");
    expect(html).not.toMatch(FORBIDDEN_DASH);
  });
});

describe("login page mark", () => {
  test("renders the 44px mark above the exact heading Log in to Settle", async () => {
    const html = renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain(">Log in to Settle<");
    expect(html).toContain("<svg");
    expect(html).toContain('width="44"');
    expect(html).toContain('aria-hidden="true"');
    expect(html.indexOf("<svg")).toBeLessThan(html.indexOf(">Log in to Settle<"));
    expect(html).not.toMatch(FORBIDDEN_DASH);
  });
});

describe("accept page mark", () => {
  test("renders the 40px mark above the title and keeps the form intact", async () => {
    const html = renderToStaticMarkup(await AcceptPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('width="40"');
    expect(html).toContain('aria-hidden="true"');
    expect(html.indexOf("<svg")).toBeLessThan(html.indexOf(ACCEPT_TITLE));
    expect(html).toContain(ACCEPT_CONFIRM);
    expect(html).toContain('name="next"');
    expect(html).not.toMatch(FORBIDDEN_DASH);
  });
});

describe("expired page mark", () => {
  test("renders the 40px mark above the title", () => {
    const html = renderToStaticMarkup(<ExpiredPage />);
    expect(html).toContain('width="40"');
    expect(html).toContain('aria-hidden="true"');
    expect(html.indexOf("<svg")).toBeLessThan(html.indexOf(EXPIRED_PAGE_TITLE));
    expect(html).toContain('href="/login"');
    expect(html).not.toMatch(FORBIDDEN_DASH);
  });
});
