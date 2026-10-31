import { describe, expect, test } from "bun:test";
import {
  PLANS,
  PLAN_ORDER,
  formatPrice,
  yearlyPerMonth,
  yearlySavingsPercent,
  type Feature,
  type PlanId,
} from "../../lib/billing/plans";

const FEATURES: Feature[] = [
  "chat_capture",
  "math_diagnosis",
  "slides_flashcards",
  "brief_checklist",
  "weak_spot_tracker",
];

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap(collectStrings);
  }
  return [];
}

describe("PLANS shape", () => {
  test("has exactly free and pro, in order", () => {
    expect(Object.keys(PLANS).sort()).toEqual(["free", "pro"]);
    expect(PLAN_ORDER).toEqual(["free", "pro"]);
  });

  test("every plan quotes every feature", () => {
    for (const id of PLAN_ORDER) {
      expect(Object.keys(PLANS[id].quotas).sort()).toEqual([...FEATURES].sort());
    }
  });

  test("free plan values", () => {
    const free = PLANS.free;
    expect(free.name).toBe("Free");
    expect(free.price.monthly).toBe(0);
    expect(free.price.yearly).toBe(0);
    expect(free.price.currency).toBe("SGD");
    expect(free.price.stars).toBeNull();
    expect(free.price.anchor).toBeNull();
    expect(free.quotas).toEqual({
      chat_capture: "unlimited",
      math_diagnosis: 3,
      slides_flashcards: 1,
      brief_checklist: 1,
      weak_spot_tracker: "unlimited",
    });
    expect(free.fairUse).toEqual({});
  });

  test("pro plan values", () => {
    const pro = PLANS.pro;
    expect(pro.name).toBe("Pro");
    expect(pro.price.monthly).toBe(7.99);
    expect(pro.price.yearly).toBe(63.99);
    expect(pro.price.currency).toBe("SGD");
    expect(pro.price.stars).toEqual({ monthly: 600 });
    expect(typeof pro.price.anchor).toBe("string");
    expect(Object.values(pro.quotas).every((q) => q === "unlimited")).toBe(true);
    expect(pro.fairUse).toEqual({
      math_diagnosis: 300,
      slides_flashcards: 60,
      brief_checklist: 60,
    });
  });

  test("free bullets state the same numbers as the free quotas", () => {
    const bullets = PLANS.free.bullets.join(" ");
    expect(bullets).toMatch(/3 math diagnoses a month/);
    expect(bullets).toMatch(/1 slide deck to flashcards a month/);
    expect(bullets).toMatch(/1 assignment brief to checklist a month/);
    expect(bullets).toMatch(/Weak-spot tracker/);
    expect(PLANS.free.bullets).toHaveLength(5);
  });

  test("pro bullets cover the unlimited starter set", () => {
    expect(PLANS.pro.bullets.join(" ")).toMatch(/Everything in Free/);
    expect(PLANS.pro.bullets.join(" ")).toMatch(/Unlimited math diagnoses/);
    expect(PLANS.pro.bullets.join(" ")).toMatch(/Unlimited briefs, slides and PDFs/);
  });

  test("anchor is nullable config, not hardcoded copy elsewhere", () => {
    expect(PLANS.pro.price.anchor).toBe("Less than a McSpicy meal.");
    expect(PLANS.free.price.anchor).toBeNull();
  });

  test("no string in the config contains an em dash or en dash", () => {
    const strings = collectStrings(PLANS);
    expect(strings.length).toBeGreaterThan(0);
    for (const s of strings) {
      expect(s).not.toMatch(/[\u2013\u2014]/);
    }
  });
});

describe("formatPrice", () => {
  test("formats SGD with the S$ prefix", () => {
    expect(formatPrice(7.99, "SGD")).toBe("S$7.99");
    expect(formatPrice(63.99, "SGD")).toBe("S$63.99");
    expect(formatPrice(0, "SGD")).toBe("S$0");
  });

  test("formats USD with the US$ prefix", () => {
    expect(formatPrice(7.99, "USD")).toBe("US$7.99");
  });

  test("never returns a bare $", () => {
    const outputs = [0, 7.99, 63.99, 5].flatMap((amount) => [
      formatPrice(amount, "SGD"),
      formatPrice(amount, "USD"),
    ]);
    for (const out of outputs) {
      expect(out.startsWith("S$") || out.startsWith("US$")).toBe(true);
    }
  });

  test("drops decimals only when the amount is a whole number", () => {
    expect(formatPrice(5, "SGD")).toBe("S$5");
    expect(formatPrice(5.5, "SGD")).toBe("S$5.50");
  });
});

describe("yearlyPerMonth", () => {
  test("pro yearly is about S$5.33 a month", () => {
    expect(yearlyPerMonth("pro")).toBe(5.33);
  });

  test("free yearly is 0", () => {
    expect(yearlyPerMonth("free")).toBe(0);
  });
});

describe("yearlySavingsPercent", () => {
  test("pro is about 33% off", () => {
    const pct = yearlySavingsPercent("pro");
    expect(pct).toBeGreaterThanOrEqual(32);
    expect(pct).toBeLessThanOrEqual(34);
    expect(pct).toBe(33);
  });

  test("free has no saving", () => {
    expect(yearlySavingsPercent("free")).toBe(0);
  });
});

describe("purity", () => {
  test("helpers do not mutate PLANS", () => {
    const before = JSON.stringify(PLANS);
    formatPrice(7.99, "SGD");
    yearlyPerMonth("pro");
    yearlySavingsPercent("pro");
    expect(JSON.stringify(PLANS)).toBe(before);
  });

  test("plan ids stay assignable to Record lookups", () => {
    const ids: PlanId[] = ["free", "pro"];
    for (const id of ids) {
      expect(PLANS[id].name.length).toBeGreaterThan(0);
    }
  });
});
