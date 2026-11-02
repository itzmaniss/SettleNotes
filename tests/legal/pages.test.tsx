import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { Metadata } from "next";

import { parseLegalMarkdown } from "@/lib/legal/markdown";
import type { LegalDocument, LegalKey } from "@/lib/legal/content";

// The pages call loadLegalDocument() with no deps, which would read env via
// getEnv and poison the shared cache for later test files. The module is
// replaced with a wrapper around the REAL loader that injects a hand made
// env, so the pages still render the actual content/legal documents.
const PAGE_ENV = {
  LEGAL_OPERATOR_NAME: "Sentinel Operator",
  LEGAL_SUPPORT_EMAIL: "legal-sentinel@example.com",
  LEGAL_SUPABASE_REGION: "ap-southeast-1",
  LEGAL_VPS_PROVIDER: "SentinelHost",
  STRIPE_MANAGED_PAYMENTS: false,
};

const realContent = await import("@/lib/legal/content");
const realLoad = realContent.loadLegalDocument;

mock.module("@/lib/legal/content", () => ({
  LEGAL_KEYS: realContent.LEGAL_KEYS,
  readLegalSource: realContent.readLegalSource,
  loadAllLegalSources: realContent.loadAllLegalSources,
  loadLegalDocument: (key: LegalKey) => realLoad(key, { env: PAGE_ENV }),
}));

const termsModule = await import("@/app/terms/page");
const privacyModule = await import("@/app/privacy/page");
const refundModule = await import("@/app/refund/page");
const { LegalDocumentView } = await import("@/components/legal/legal-document");

const docs: Record<LegalKey, LegalDocument> = {
  terms: realLoad("terms", { env: PAGE_ENV }),
  privacy: realLoad("privacy", { env: PAGE_ENV }),
  refund: realLoad("refund", { env: PAGE_ENV }),
};

type PageEntry = {
  name: string;
  key: LegalKey;
  page: () => Promise<React.ReactElement> | React.ReactElement;
  metadata: Metadata;
  dynamic: string;
};

const pages: PageEntry[] = [
  {
    name: "terms",
    key: "terms",
    page: termsModule.default,
    metadata: termsModule.metadata,
    dynamic: termsModule.dynamic,
  },
  {
    name: "privacy",
    key: "privacy",
    page: privacyModule.default,
    metadata: privacyModule.metadata,
    dynamic: privacyModule.dynamic,
  },
  {
    name: "refund",
    key: "refund",
    page: refundModule.default,
    metadata: refundModule.metadata,
    dynamic: refundModule.dynamic,
  },
];

describe("legal page metadata", () => {
  test.each([["terms", "Terms"], ["privacy", "Privacy"], ["refund", "Refunds"]])(
    "%s has the plain title and a description, and stays indexable",
    (key, title) => {
      const entry = pages.find((page) => page.name === key)!;
      expect(entry.metadata.title).toBe(title);
      expect(entry.metadata.description?.length ?? 0).toBeGreaterThan(10);
      // No robots block anywhere: the pages are meant for search engines.
      expect(entry.metadata.robots).toBeUndefined();
    },
  );

  test.each(["terms", "privacy", "refund"])("%s renders per request", (key) => {
    const entry = pages.find((page) => page.name === key)!;
    expect(entry.dynamic).toBe("force-dynamic");
  });
});

describe("legal pages render the real documents", () => {
  for (const entry of pages) {
    test(`${entry.name}: h1, effective date, tokens filled, no scripts`, async () => {
      const html = renderToStaticMarkup(await entry.page());
      expect(html).toContain("<h1");
      expect(html).toContain(docs[entry.key].title);
      expect(html).toContain("1 November 2026");
      // Every token was filled before parsing: no template syntax survives.
      expect(html).not.toContain("{{");
      expect(html).not.toContain("}}");
      expect(html).not.toContain("<script");
      // The footer links to the sibling pages, and the header to home.
      expect(html).toContain('href="/terms"');
      expect(html).toContain('href="/privacy"');
      expect(html).toContain('href="/refund"');
      expect(html).toContain('href="/"');
    });

    test(`${entry.name}: counsel markers become visible note boxes, never raw [[`, async () => {
      const html = renderToStaticMarkup(await entry.page());
      if (docs[entry.key].markers.length > 0) {
        expect(html).toContain("Waiting for review");
        expect(html).toContain("[[COUNSEL:");
      } else {
        expect(html).not.toContain("Waiting for review");
      }
      // A MISSING or UNKNOWN TOKEN leak would mean broken env or a typo'd
      // token; neither may ever reach a rendered page.
      expect(html).not.toContain("[[MISSING:");
      expect(html).not.toContain("[[UNKNOWN TOKEN:");
    });
  }

  test("terms and privacy carry the four counsel markers, refund is clean", () => {
    expect(docs.terms.markers.length).toBe(2);
    expect(docs.privacy.markers.length).toBe(2);
    expect(docs.refund.markers.length).toBe(0);
  });
});

describe("the legal document component", () => {
  const fixtureSource = [
    "## The rules",
    "",
    "Be **kind**. Read the [Privacy Notice](/privacy).",
    "External [Meta terms](https://dev.meta.ai/legal) apply. Email legal-sentinel@example.com.",
    "[[COUNSEL: confirm the cap.]]",
    "",
    "- one [linked item](/terms)",
    "- plain item",
  ].join("\n");

  const fixture: LegalDocument = {
    key: "terms",
    title: "Fixture Terms",
    blocks: parseLegalMarkdown(fixtureSource),
    markers: ["[[COUNSEL: confirm the cap.]]"],
  };

  function render(): string {
    return renderToStaticMarkup(<LegalDocumentView doc={fixture} />);
  }

  test("renders the shell: header logo home link, article, footer legal nav", () => {
    const html = render();
    expect(html).toContain("<header");
    expect(html).toContain("<footer");
    expect(html).toContain("<article");
    expect(html).toContain('aria-label="Settle home"');
    expect(html).toContain('aria-label="Legal"');
    expect(html).toContain("<h1");
    expect(html).toContain("<h2");
    expect(html).toContain("<ul");
  });

  test("relative, external and mailto links render with the right rel", () => {
    const html = render();
    // Relative link: no rel attribute, whatever order the attributes land in.
    const relative = /<a [^>]*href="\/privacy"[^>]*>/.exec(html)?.[0] ?? "";
    expect(relative).not.toBe("");
    expect(relative).not.toContain("rel=");
    // External https link: rel from the span.
    const external = /<a [^>]*href="https:\/\/dev\.meta\.ai\/legal"[^>]*>/.exec(html)?.[0] ?? "";
    expect(external).toContain('rel="noopener noreferrer"');
    // Bare email becomes a mailto link.
    const mail = /<a [^>]*href="mailto:legal-sentinel@example\.com"[^>]*>/.exec(html)?.[0] ?? "";
    expect(mail).not.toBe("");
    expect(mail).not.toContain("rel=");
  });

  test("the counsel marker is a lilac bordered note box with the review label", () => {
    const html = render();
    expect(html).toContain("Waiting for review");
    expect(html).toContain("bg-pop-soft");
    expect(html).toContain("border-2 border-border");
    expect(html).toContain("[[COUNSEL: confirm the cap.]]");
  });

  test("bold spans render strong and list links keep a 44px tap height", () => {
    const html = render();
    expect(html).toContain("<strong>kind</strong>");
    expect(html).toContain("min-h-[44px]");
    expect(html).toContain("<li");
  });

  test("no script tags and no template braces in the rendered output", () => {
    const html = render();
    expect(html).not.toContain("<script");
    expect(html).not.toContain("{{");
    expect(html).not.toContain("}}");
  });
});

describe("the legal pages are public", () => {
  test("the middleware matcher never lists the legal paths", () => {
    const middleware = readFileSync(new URL("../../middleware.ts", import.meta.url), "utf8");
    const matcher = /matcher:\s*\[([^\]]+)\]/.exec(middleware);
    expect(matcher).not.toBeNull();
    const entries = matcher![1]
      .split(",")
      .map((raw) => raw.trim().replace(/^["']|["']$/g, ""));
    expect(entries.length).toBeGreaterThan(0);
    for (const path of ["/terms", "/privacy", "/refund"]) {
      expect(entries.some((entry) => entry.startsWith(path)), path).toBe(false);
    }
  });

  test("the access decision allows the legal paths without any session", async () => {
    const { decideAccess } = await import("@/lib/auth/access");
    const { isProtectedPath } = await import("@/lib/auth/paths");
    for (const path of ["/terms", "/privacy", "/refund"]) {
      expect(isProtectedPath(path), path).toBe(false);
      expect(await decideAccess(path, undefined, undefined, new Date())).toBe("allow");
    }
  });
});
