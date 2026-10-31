import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

// plan.ts pulls the billing seams for limitFor and nextPeriodStart, which
// transitively import "server-only". Neutralize it, then load the real modules.
mock.module("server-only", () => ({}));

const { buildPlanView, usageLine } = await import("@/lib/dashboard/plan");
const { PlanCard } = await import("@/components/dashboard/plan-card");

// 28 Oct 2026, 09:00 SGT: inside the October period, resetting on 1 Nov.
const NOW = new Date("2026-10-28T01:00:00.000Z");

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

describe("buildPlanView", () => {
  test("free: the three metered rows with their used counts and free limits", () => {
    const view = buildPlanView({
      plan: "free",
      usage: { math_diagnosis: 2, slides_flashcards: 1, brief_checklist: 0 },
      now: NOW,
    });
    expect(view.planName).toBe("Free");
    expect(view.rows).toEqual([
      { feature: "math_diagnosis", label: "Math checks", used: 2, limit: 3, resetsOn: "1 Nov" },
      { feature: "slides_flashcards", label: "Slide decks", used: 1, limit: 1, resetsOn: "1 Nov" },
      { feature: "brief_checklist", label: "Briefs to checklist", used: 0, limit: 1, resetsOn: "1 Nov" },
    ]);
  });

  test("missing usage entries count as zero", () => {
    const view = buildPlanView({ plan: "free", usage: {}, now: NOW });
    expect(view.rows.map((row) => row.used)).toEqual([0, 0, 0]);
  });

  test("pro: every row reads unlimited, never the fair-use caps", () => {
    const view = buildPlanView({
      plan: "pro",
      usage: { math_diagnosis: 12, slides_flashcards: 3, brief_checklist: 1 },
      now: NOW,
    });
    expect(view.planName).toBe("Pro");
    for (const row of view.rows) {
      expect(row.limit).toBe("unlimited");
    }
    const rendered = JSON.stringify(view);
    expect(rendered).not.toContain("300");
    expect(rendered).not.toContain("60");
  });

  test("the reset date is 00:00 SGT on the 1st of the next month", () => {
    expect(buildPlanView({ plan: "free", usage: {}, now: NOW }).resetsOn).toBe("1 Nov");
    // Mid December rolls over to January.
    const december = buildPlanView({
      plan: "free",
      usage: {},
      now: new Date("2026-12-15T10:00:00.000Z"),
    });
    expect(december.resetsOn).toBe("1 Jan");
    // Late on 31 Oct SGT (23:00) is still October, resetting on 1 Nov.
    const lateOctober = buildPlanView({
      plan: "free",
      usage: {},
      now: new Date("2026-10-31T15:00:00.000Z"),
    });
    expect(lateOctober.resetsOn).toBe("1 Nov");
    // 01:30 SGT on 1 Nov is November, resetting on 1 Dec.
    const november = buildPlanView({
      plan: "free",
      usage: {},
      now: new Date("2026-10-31T17:30:00.000Z"),
    });
    expect(november.resetsOn).toBe("1 Dec");
  });
});

describe("usageLine", () => {
  test("'used of limit' for a capped row, 'used' alone when unlimited", () => {
    expect(usageLine({ feature: "math_diagnosis", label: "Math checks", used: 2, limit: 3, resetsOn: "1 Nov" })).toBe("2 of 3");
    expect(usageLine({ feature: "math_diagnosis", label: "Math checks", used: 12, limit: "unlimited", resetsOn: "1 Nov" })).toBe("12 used");
  });
});

describe("PlanCard", () => {
  const freeView = buildPlanView({
    plan: "free",
    usage: { math_diagnosis: 2, slides_flashcards: 1, brief_checklist: 0 },
    now: NOW,
  });

  test("renders the plan name, the three rows, the reset date and the disabled button", () => {
    const html = render(<PlanCard view={freeView} />);
    expect(html).toContain("Free");
    expect(html).toContain("Math checks");
    expect(html).toContain("Slide decks");
    expect(html).toContain("Briefs to checklist");
    expect(html).toContain("2 of 3");
    expect(html).toContain("1 of 1");
    expect(html).toContain("0 of 1");
    expect(html).toContain("Resets 1 Nov");
    expect(html).toContain("Coming soon");
    expect(html).toContain("disabled"); // a real disabled button, not a link
    expect(html).not.toContain("<a "); // no checkout link hiding anywhere
  });

  test("billing open: the button becomes a /billing link", () => {
    const html = render(<PlanCard view={freeView} billingOpen />);
    expect(html).toContain("See plans");
    expect(html).toContain('href="/billing"');
    expect(html).not.toContain("Coming soon");
    // The disabled variants in the class list always render; the attribute
    // must not.
    expect(html).not.toMatch(/\sdisabled[=\s>]/);
  });

  test("no price numbers anywhere in the markup", () => {
    const html = render(<PlanCard view={freeView} />);
    expect(html).not.toContain("S$");
    expect(html).not.toContain("7.99");
    expect(html).not.toContain("63.99");
  });

  test("no em or en dashes in any rendered copy", () => {
    const html = render(<PlanCard view={freeView} />);
    expect(html).not.toMatch(/[\u2014\u2013]/);
  });

  test("a pro card reads unlimited instead of caps", () => {
    const proView = buildPlanView({ plan: "pro", usage: {}, now: NOW });
    const html = render(<PlanCard view={proView} />);
    expect(html).toContain("Pro");
    expect(html).toContain("0 used");
    expect(html).not.toContain("of 300");
    expect(html).not.toContain("of 60");
  });
});
