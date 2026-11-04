import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import Home from "@/app/page";
import { buildLandingJsonld, toJsonLdScript } from "@/lib/seo/jsonld";

type Node = Record<string, unknown>;

const ORIGIN = new URL("https://settlenotes.com");

function graph(): Node[] {
  return buildLandingJsonld(ORIGIN)["@graph"] as Node[];
}

describe("buildLandingJsonld", () => {
  test("a graph of exactly organization, website and app", () => {
    expect(buildLandingJsonld(ORIGIN)["@context"]).toBe("https://schema.org");
    expect(graph().map((node) => node["@type"])).toEqual([
      "Organization",
      "WebSite",
      "SoftwareApplication",
    ]);
  });

  test("organization and website carry the canonical origin, logo absolute", () => {
    const [org, website] = graph();
    expect(org!["url"]).toBe("https://settlenotes.com/");
    expect(org!["logo"]).toBe("https://settlenotes.com/brand/settle-icon-512.png");
    expect(org!["name"]).toBe("SettleNotes");
    expect(website!["url"]).toBe("https://settlenotes.com/");
    expect(website!["name"]).toBe("SettleNotes");
  });

  test("the app offer is the free plan only, nothing invented", () => {
    const app = graph()[2]!;
    expect(app["name"]).toBe("SettleNotes");
    expect(app["applicationCategory"]).toBe("EducationalApplication");
    expect(app["operatingSystem"]).toBe("Telegram");
    expect(app["offers"]).toEqual({ "@type": "Offer", price: "0", priceCurrency: "SGD" });
    // No rating, no review, no second offer: Pro is not on sale and a made up
    // number would be a fake claim.
    const serialized = JSON.stringify(buildLandingJsonld(ORIGIN));
    expect(serialized).not.toContain("aggregateRating");
    expect(serialized).not.toContain("review");
    expect(serialized).not.toContain("Pro");
  });

  test("the description is the honest landing copy", () => {
    const app = graph()[2]!;
    const description = app["description"] as string;
    expect(description).toContain("Telegram bot");
    expect(description).not.toMatch(/[\u2013\u2014]/);
    expect(description.length).toBeLessThan(160);
  });
});

describe("toJsonLdScript", () => {
  test("round trips: parsing the script body returns the original value", () => {
    const value = buildLandingJsonld(ORIGIN);
    expect(JSON.parse(toJsonLdScript(value))).toEqual(value);
  });

  test("a hostile description cannot break out of the script tag", () => {
    const hostile = {
      description: "</script><script>alert(1)</script>",
      nested: { deep: ["<b>x</b>", "<img onerror=x>"] },
    };
    const body = toJsonLdScript(hostile);
    expect(body).not.toContain("<");
    expect(JSON.parse(body)).toEqual(hostile);
  });
});

describe("the landing page renders the tag", () => {
  test("exactly one application/ld+json script with parseable content", () => {
    const html = renderToStaticMarkup(<Home />);
    const scripts = html.match(/<script type="application\/ld\+json">/g) ?? [];
    expect(scripts).toHaveLength(1);
    const match = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
    expect(match).not.toBeNull();
    const parsed = JSON.parse(match![1]!) as Node;
    expect(parsed["@context"]).toBe("https://schema.org");
    expect(((parsed["@graph"] as Node[])[2]!)["offers"]).toEqual({
      "@type": "Offer",
      price: "0",
      priceCurrency: "SGD",
    });
  });
});
