import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AcceptVisitor } from "@/lib/auth/accept";

// The real deps read env (and would poison the shared getEnv cache for later
// test files), so the accept module is replaced with a controllable fake. The
// cookie store is mocked too: the page calls cookies() before the visitor is
// resolved, and a bare store is enough because the fake decides the outcome.
let nextVisitor: AcceptVisitor | null = { kind: "consent", claims: { tid: 900000001, fn: "Wei" } };

mock.module("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => ({ get: () => null }),
}));

mock.module("@/lib/auth/accept", () => ({
  resolveAcceptVisitor: async () => nextVisitor,
  // The page builds deps before calling the (mocked) resolver, so this must
  // return a harmless object rather than throw.
  realAcceptDeps: () => ({}) as never,
  // The actions module imports this; never called in this file.
  performAccept: async () => ({ kind: "anonymous" }),
}));

const { default: AcceptPage, metadata } = await import("@/app/accept/page");
const { ACCEPT_BODY, ACCEPT_CONFIRM, ACCEPT_DECLINE, ACCEPT_TITLE } = await import(
  "@/lib/legal/consent-copy"
);

function digestOf(error: unknown): string {
  return (error as { digest?: string }).digest ?? "";
}

describe("/accept metadata", () => {
  test("title is One quick step and the page is noindex", () => {
    expect(metadata.title).toBe("One quick step");
    expect(JSON.stringify(metadata.robots)).toContain('"index":false');
  });
});

describe("/accept page", () => {
  test("with no verified cookie it redirects to /login", async () => {
    nextVisitor = null;
    try {
      await AcceptPage({ searchParams: Promise.resolve({}) });
      throw new Error("expected a redirect");
    } catch (error) {
      expect(digestOf(error)).toContain("/login");
    }
  });

  test("a signed-in visitor who already accepted is sent to the dashboard", async () => {
    nextVisitor = { kind: "accepted" };
    try {
      await AcceptPage({ searchParams: Promise.resolve({}) });
      throw new Error("expected a redirect");
    } catch (error) {
      expect(digestOf(error)).toContain("/dashboard");
    }
  });

  test("a consent cookie renders the acceptance form with legal links", async () => {
    nextVisitor = { kind: "consent", claims: { tid: 900000001, fn: "Wei" } };
    const html = renderToStaticMarkup(
      await AcceptPage({ searchParams: Promise.resolve({}) }),
    );

    expect(html).toContain(ACCEPT_TITLE);
    expect(html).toContain(ACCEPT_BODY);
    expect(html).toContain('href="/terms"');
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('href="/refund"');
    expect(html).toContain(ACCEPT_CONFIRM);
    expect(html).toContain(ACCEPT_DECLINE);
    expect(html).toContain('href="/"');
    // The hidden field carries the navigation hint only, never identity.
    expect(html).toContain('name="next"');
  });

  test("the next hint is constrained: an evil value renders as the dashboard", async () => {
    nextVisitor = { kind: "consent", claims: { tid: 900000001, fn: "Wei" } };
    const html = renderToStaticMarkup(
      await AcceptPage({ searchParams: Promise.resolve({ next: "//evil.com" }) }),
    );
    expect(html).toContain('value="/dashboard"');
    expect(html).not.toContain("evil.com");
  });

  test("a safe next hint is kept in the hidden field", async () => {
    nextVisitor = { kind: "consent", claims: { tid: 900000001, fn: "Wei" } };
    const html = renderToStaticMarkup(
      await AcceptPage({ searchParams: Promise.resolve({ next: "/billing" }) }),
    );
    expect(html).toContain('value="/billing"');
  });
});
