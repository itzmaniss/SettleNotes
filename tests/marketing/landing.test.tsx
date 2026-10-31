import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import Home, { metadata } from "@/app/page";
import { botLink } from "@/components/marketing/links";
import { HowItWorks } from "@/components/marketing/how-it-works";
import { buildPricingCards } from "@/components/marketing/pricing";
import { PricingSection } from "@/components/marketing/pricing-section";
import {
  PLANS,
  PLAN_ORDER,
  formatPrice,
  yearlyPerMonth,
  yearlySavingsPercent,
} from "@/lib/billing/plans";

const MARKETING_DIR = join(import.meta.dir, "..", "..", "components", "marketing");

// Tests juggle BILLING_ENABLED and TELEGRAM_BOT_USERNAME; whatever a test
// sets, the next one starts from the real environment again.
const SAVED_ENV = new Map(
  ["BILLING_ENABLED", "TELEGRAM_BOT_USERNAME"].map((key) => [
    key,
    process.env[key],
  ])
);

function setEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  for (const [key, value] of SAVED_ENV) setEnv(key, value);
});

function renderPricing(overrides: {
  billingEnabled?: boolean;
  botHref?: string | null;
  defaultPeriod?: "monthly" | "yearly";
  cards?: ReturnType<typeof buildPricingCards>;
}): string {
  return renderToStaticMarkup(
    <PricingSection
      cards={overrides.cards ?? buildPricingCards()}
      billingEnabled={overrides.billingEnabled ?? false}
      botHref={overrides.botHref ?? null}
      yearlySavePercent={yearlySavingsPercent("pro")}
      heading={<h2>Pricing</h2>}
      defaultPeriod={overrides.defaultPeriod}
    />
  );
}

describe("botLink", () => {
  test("null when unset", () => {
    setEnv("TELEGRAM_BOT_USERNAME", undefined);
    expect(botLink()).toBeNull();
  });

  test("null when blank", () => {
    setEnv("TELEGRAM_BOT_USERNAME", "   ");
    expect(botLink()).toBeNull();
  });

  test("strips a leading @", () => {
    setEnv("TELEGRAM_BOT_USERNAME", "@settle_bot");
    expect(botLink()).toBe("https://t.me/settle_bot");
  });

  test("plain username becomes a https link", () => {
    setEnv("TELEGRAM_BOT_USERNAME", "settle_bot");
    expect(botLink()).toBe("https://t.me/settle_bot");
  });
});

describe("PricingSection renders from plans config", () => {
  test("monthly state shows formatted config prices, names and bullets", () => {
    const html = renderPricing({});
    expect(html).toContain(formatPrice(PLANS.pro.price.monthly, "SGD"));
    expect(html).toContain(formatPrice(PLANS.free.price.monthly, "SGD"));
    for (const id of PLAN_ORDER) {
      expect(html).toContain(PLANS[id].name);
      for (const bullet of PLANS[id].bullets) {
        expect(html).toContain(bullet);
      }
    }
  });

  test("yearly state shows the yearly and per-month formatted prices", () => {
    const html = renderPricing({ defaultPeriod: "yearly" });
    expect(html).toContain(formatPrice(PLANS.pro.price.yearly, "SGD"));
    expect(html).toContain(formatPrice(yearlyPerMonth("pro"), "SGD"));
    expect(html).not.toContain(formatPrice(PLANS.pro.price.monthly, "SGD"));
    expect(html).toContain(`save ${yearlySavingsPercent("pro")}%`);
  });

  test("no hardcoded price literals in any marketing source file", () => {
    const priceLike = /S\$\s*\d|\d+\.\d{2}(?!\d)/;
    for (const file of readdirSync(MARKETING_DIR)) {
      if (!/\.(tsx|ts)$/.test(file)) continue;
      const source = readFileSync(join(MARKETING_DIR, file), "utf8");
      expect(source.match(priceLike) ?? [], `${file} hardcodes a price`).toEqual(
        []
      );
    }
  });

  test("billing off: Pro button disabled, says Coming soon, no payment line", () => {
    const html = renderPricing({ billingEnabled: false });
    expect(html).toContain("Coming soon");
    expect(html).toContain("disabled");
    expect(html).not.toContain("Get Pro");
    expect(html).not.toContain("Pay with card");
    expect(html).not.toContain('href="/billing"');
  });

  test("billing off: the disabled Pro button uses the deliberate dashed style", () => {
    const html = renderPricing({ billingEnabled: false });
    expect(html).toMatch(/<button[^>]*\bdisabled\b/);
    for (const marker of [
      "disabled:border-dashed",
      "disabled:bg-transparent",
      "disabled:text-foreground",
      "disabled:opacity-100",
      "disabled:shadow-none",
    ]) {
      expect(html).toContain(marker);
    }
  });

  test("billing on: Pro button is a /billing link with the web payment line", () => {
    const html = renderPricing({
      billingEnabled: true,
      botHref: "https://t.me/settle_bot",
    });
    expect(html).toContain("Get Pro");
    expect(html).toContain('href="/billing"');
    expect(html).toContain("Subscribe on the web with a card or PayNow.");
    expect(html).not.toContain("Coming soon");
    expect(html).toContain('href="https://t.me/settle_bot"');
  });

  test("no Stars number and no bot upsell next to the Pro button", () => {
    const html = renderPricing({ billingEnabled: true, botHref: "https://t.me/settle_bot" });
    // Selling happens on the web; the bot mention stays neutral and numberless.
    expect(html).not.toContain("Stars");
    expect(html).not.toMatch(/600/);
  });

  test("anchor sticker renders only when the plan has one", () => {
    const anchor = PLANS.pro.price.anchor;
    expect(anchor).not.toBeNull();
    expect(renderPricing({})).toContain(anchor as string);
    const noAnchor = buildPricingCards().map((card) => ({
      ...card,
      anchor: null,
    }));
    expect(renderPricing({ cards: noAnchor })).not.toContain("McSpicy");
  });
});

describe("landing page", () => {
  function renderPage(): string {
    return renderToStaticMarkup(<Home />);
  }

  test("renders with BILLING_ENABLED and TELEGRAM_BOT_USERNAME unset", () => {
    setEnv("BILLING_ENABLED", undefined);
    setEnv("TELEGRAM_BOT_USERNAME", undefined);
    const html = renderPage();
    expect(html).toContain("Bot link coming soon");
    expect(html).toContain("Coming soon");
  });

  test("exactly one h1", () => {
    expect(renderPage().match(/<h1\b/g)).toHaveLength(1);
  });

  test("hero intro line is quiet text, not a pill badge", () => {
    const html = renderPage();
    expect(html).toMatch(/<p[^>]*>made for SG students<\/p>/);
    expect(html).not.toMatch(/<span[^>]*>[^<]*made for SG students/);
  });

  test("nav keeps Log in beside the primary button, with a 44px tap target", () => {
    setEnv("TELEGRAM_BOT_USERNAME", "settle_bot");
    const html = renderPage();
    const group = html.indexOf('<div class="flex items-center gap-4">');
    const login = html.indexOf("Log in");
    const button = html.indexOf("Open in Telegram");
    expect(group).toBeGreaterThan(-1);
    expect(login).toBeGreaterThan(group);
    expect(button).toBeGreaterThan(login);
    expect(html).toContain("min-h-11");
  });

  test("nav links only to sections that exist, no For tutors", () => {
    const html = renderPage();
    expect(html).not.toContain("For tutors");
    expect(html).toContain('id="how"');
    expect(html).toContain('id="pricing"');
  });

  test("no em or en dash anywhere in the rendered markup", () => {
    expect(renderPage().match(/[\u2013\u2014]/g) ?? []).toEqual([]);
  });

  test("metadata is real plain copy", () => {
    const titleText =
      typeof metadata.title === "string"
        ? metadata.title
        : JSON.stringify(metadata.title);
    expect(titleText).not.toContain("Create Next App");
    expect(titleText).toContain("Settle");
    expect(metadata.description).toBeTruthy();
    expect(metadata.description).not.toMatch(/[\u2013\u2014]/);
    expect(metadata.openGraph?.title).toBeTruthy();
  });
});

describe("HowItWorks hierarchy", () => {
  function renderHow(): string {
    return renderToStaticMarkup(<HowItWorks />);
  }

  test("step 1 leads with a wider column and a large numeral", () => {
    const html = renderHow();
    expect(html).toContain("md:grid-cols-[1.3fr_1fr_1fr]");
    expect(html).toMatch(/text-5xl font-extrabold[^>]*>1</);
  });

  test("steps 2 and 3 keep the compact sticker numerals, same content order", () => {
    const html = renderHow();
    expect(html.match(/rounded-full border-2 border-border/g)).toHaveLength(2);
    expect(html.indexOf("Forward it")).toBeLessThan(
      html.indexOf("Settle sorts it")
    );
    expect(html.indexOf("Settle sorts it")).toBeLessThan(
      html.indexOf("Your first step is already done")
    );
  });
});
